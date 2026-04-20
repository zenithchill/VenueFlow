/**
 * @fileoverview VenueFlow — Google Cloud Functions Backend
 *
 * Serverless backend providing:
 *   1. BigQuery zone snapshot sync           (Firebase RTDB trigger)
 *   2. Vertex AI Gemini Pro crowd prediction (Cloud Scheduler, every 5 min)
 *   3. Firestore incident → BigQuery pipeline (Firestore document trigger)
 *   4. Cloud Natural Language sentiment      (HTTP endpoint)
 *   5. Daily BigQuery aggregation report     (Cloud Scheduler, daily)
 *   6. BigQuery schema initialisation        (HTTP endpoint)
 *   7. Pub/Sub zone alert broadcasting       (event-driven)
 *
 * Deploy:  firebase deploy --only functions
 * Runtime: Node.js 20
 *
 * @module VenueFlowCloudFunctions
 * @version 2.0.0
 */

'use strict';

const { onRequest }         = require('firebase-functions/v2/https');
const { onSchedule }        = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onValueUpdated }    = require('firebase-functions/v2/database');

const admin = require('firebase-admin');
const { BigQuery }               = require('@google-cloud/bigquery');
const { VertexAI: VertexAIClient } = require('@google-cloud/vertexai');
const { LanguageServiceClient }  = require('@google-cloud/language');
const { PubSub }                 = require('@google-cloud/pubsub');

// ── SDK initialisation ────────────────────────────────────────────────────
admin.initializeApp();

const db          = admin.database();
const firestore   = admin.firestore();
const bigquery    = new BigQuery({ projectId: 'venueflow-demo' });
const vertexai    = new VertexAIClient({ project: 'venueflow-demo', location: 'us-central1' });
const nlpClient   = new LanguageServiceClient();
const pubSubClient = new PubSub({ projectId: 'venueflow-demo' });

// ── Constants ─────────────────────────────────────────────────────────────
const PROJECT    = 'venueflow-demo';
const DATASET_ID = 'venueflow_analytics';
const TBL_ZONES  = 'zone_snapshots';
const TBL_INC    = 'incidents';
const TBL_AGG    = 'daily_aggregations';
const TBL_SENT   = 'fan_sentiment';
const TOPIC      = 'zone-density-alerts';
const REGION     = 'us-central1';

// ─────────────────────────────────────────────────────────────────────────
// 1. RTDB TRIGGER — sync zone snapshots to BigQuery
// Fires whenever /venues/wembley/zones changes in Firebase RTDB.
// Inserts a time-series row per zone for historical analytics and ML training.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Firebase Realtime Database trigger.
 * Extracts zone density metrics when data changes and inserts rows
 * into the BigQuery zone_snapshots table for time-series analysis.
 *
 * @type {CloudFunction<DatabaseEvent<DataSnapshot>>}
 */
exports.zoneDensityToBigQuery = onValueUpdated(
  { ref: '/venues/wembley/zones', region: REGION },
  async (event) => {
    const zones = event.data.after.val();
    if (!zones) return null;

    const rows = Object.entries(zones).map(([zoneId, zone]) => ({
      zone_id:      zoneId,
      zone_name:    zone.name    || '',
      density_pct:  zone.density || 0,
      wait_minutes: zone.wait    || 0,
      status:       zone.status  || 'clear',
      venue:        'wembley',
      match_day:    28,
      timestamp:    bigquery.timestamp(new Date()),
    }));

    await bigquery.dataset(DATASET_ID).table(TBL_ZONES).insert(rows);
    console.log(`[BigQuery] Inserted ${rows.length} zone snapshot rows`);
    return { inserted: rows.length };
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 2. SCHEDULER — Vertex AI Gemini Pro crowd prediction (every 5 min)
// Reads current zone states from RTDB, calls Gemini Pro for a structured
// prediction, writes result to Firestore, and broadcasts via Pub/Sub.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cloud Scheduler trigger (every 5 minutes).
 * Generates a Vertex AI Gemini Pro crowd congestion prediction and
 * distributes it to all subscriber clients via Pub/Sub.
 *
 * @type {CloudFunction<ScheduledEvent>}
 */
exports.vertexAiCrowdPredict = onSchedule(
  { schedule: 'every 5 minutes', region: REGION, timeoutSeconds: 60 },
  async (_event) => {
    const snap  = await db.ref('/venues/wembley/zones').get();
    const zones = snap.val() || {};

    const zoneLines = Object.entries(zones)
      .map(([id, z]) => `${id}: density=${z.density}%, wait=${z.wait}min, status=${z.status}`)
      .join('\n');

    const prompt = [
      'You are VenueFlow AI managing a live 80,000-capacity stadium event.',
      'Current zone states:\n' + zoneLines,
      'Return JSON only: { riskLevel (critical|high|medium|low), prediction (string <60 words),',
      'recommendedActions (string[3]), estimatedTimeToResolve (string), confidence (0-1) }',
    ].join('\n');

    // Vertex AI Gemini Pro inference
    const model  = vertexai.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const result = await model.generateContent(prompt);
    const raw    = result.response.candidates[0].content.parts[0].text;
    const start  = raw.indexOf('{');
    const end    = raw.lastIndexOf('}') + 1;
    const prediction = JSON.parse(raw.slice(start, end));

    // Persist to Firestore for frontend polling
    await firestore.collection('predictions').doc('latest').set({
      ...prediction,
      model:     'gemini-1.5-pro',
      venue:     'wembley',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Broadcast via Pub/Sub
    const topic   = pubSubClient.topic(TOPIC);
    const message = { type: 'ai_prediction', ...prediction, ts: new Date().toISOString() };
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(message)) });

    console.log(`[Vertex AI] Prediction complete — riskLevel: ${prediction.riskLevel}`);
    return prediction;
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 3. FIRESTORE TRIGGER — incident → BigQuery + Pub/Sub pipeline
// Fires on any create/update of an incident document.
// Pipes incident data to BigQuery and broadcasts critical alerts via Pub/Sub.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Firestore document trigger.
 * Writes incident records to BigQuery for analytics and
 * publishes Pub/Sub alerts for critical (open) incidents.
 *
 * @type {CloudFunction<FirestoreEvent>}
 */
exports.incidentToBigQuery = onDocumentWritten(
  { document: 'incidents/{incidentId}', region: REGION },
  async (event) => {
    const after  = event.data.after.data();
    if (!after) return; // deleted

    const before = event.data.before.data();
    const isNew  = !before;

    await bigquery.dataset(DATASET_ID).table(TBL_INC).insert([{
      incident_id: event.params.incidentId,
      title:       after.title    || '',
      type:        after.type     || 'open',
      location:    after.loc      || '',
      severity:    after.severity || 'medium',
      venue:       'wembley',
      is_new:      isNew,
      resolved:    after.type === 'resolved',
      timestamp:   bigquery.timestamp(new Date()),
    }]);

    // Alert on new open incidents
    if (after.type === 'open' && isNew) {
      const topic = pubSubClient.topic(TOPIC);
      await topic.publishMessage({
        data: Buffer.from(JSON.stringify({
          type:  'incident_alert',
          title: after.title,
          venue: 'wembley',
          ts:    new Date().toISOString(),
        })),
        attributes: { severity: after.severity || 'medium' },
      });
    }

    console.log(`[Firestore→BigQuery] Incident ${event.params.incidentId} (new=${isNew})`);
    return { inserted: true, isNew };
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 4. HTTP ENDPOINT — Cloud Natural Language fan sentiment analysis
// Accepts POST { texts: string[] }, returns per-text and aggregate sentiment.
// Results are also inserted into BigQuery fan_sentiment table.
// ─────────────────────────────────────────────────────────────────────────

/**
 * HTTP Cloud Function — Cloud NLP sentiment analysis.
 * Accepts a JSON body with { texts: string[] } and returns structured
 * sentiment scores for each text plus an aggregate average.
 *
 * @type {CloudFunction<Request, Response>}
 */
exports.analyzeFanSentiment = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { texts = [] } = req.body;
    if (!Array.isArray(texts) || !texts.length) {
      return res.status(400).json({ error: '`texts` array is required' });
    }

    const results = await Promise.all(
      texts.map(async (text) => {
        const [result] = await nlpClient.analyzeSentiment({
          document: { type: 'PLAIN_TEXT', content: String(text).slice(0, 1000) },
        });
        const s = result.documentSentiment;
        return {
          text:      String(text).slice(0, 80),
          score:     s.score,
          magnitude: s.magnitude,
          label:     s.score >= 0.35 ? 'Positive' : s.score <= -0.35 ? 'Negative' : 'Neutral',
        };
      })
    );

    // Fire-and-forget: log batch to BigQuery for trend analysis
    bigquery.dataset(DATASET_ID).table(TBL_SENT).insert(
      results.map(r => ({ ...r, venue: 'wembley', timestamp: bigquery.timestamp(new Date()) }))
    ).catch(err => console.error('[BigQuery] Sentiment insert error:', err.message));

    const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
    res.json({ results, averageScore: +avgScore.toFixed(3), count: results.length });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 5. SCHEDULER — Daily BigQuery aggregation report  (23:00 UTC)
// Aggregates the day's zone snapshots into a single summary row
// so BI tools and post-match reports have easy access to KPIs.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cloud Scheduler trigger (daily at 23:00 UTC).
 * Runs a BigQuery INSERT...SELECT to aggregate the day's zone events
 * into the daily_aggregations table.
 *
 * @type {CloudFunction<ScheduledEvent>}
 */
exports.dailyBigQueryAggregation = onSchedule(
  { schedule: '0 23 * * *', timeZone: 'UTC', region: REGION },
  async (_event) => {
    const sql = `
      INSERT INTO \`${PROJECT}.${DATASET_ID}.${TBL_AGG}\`
        (venue, match_day, avg_density, peak_density, avg_wait, peak_wait,
         total_incidents, total_zone_events, aggregated_at)
      SELECT
        venue,
        match_day,
        AVG(density_pct)  AS avg_density,
        MAX(density_pct)  AS peak_density,
        AVG(wait_minutes) AS avg_wait,
        MAX(wait_minutes) AS peak_wait,
        (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET_ID}.${TBL_INC}\`
         WHERE DATE(timestamp) = CURRENT_DATE())  AS total_incidents,
        COUNT(*)          AS total_zone_events,
        CURRENT_TIMESTAMP() AS aggregated_at
      FROM \`${PROJECT}.${DATASET_ID}.${TBL_ZONES}\`
      WHERE DATE(timestamp) = CURRENT_DATE()
      GROUP BY venue, match_day
    `.trim();

    const [job]  = await bigquery.createQueryJob({ query: sql, useLegacySql: false });
    const [rows] = await job.getQueryResults();
    console.log(`[BigQuery] Daily aggregation — ${rows.length} summary rows written`);
    return { rows: rows.length };
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 6. HTTP ENDPOINT — BigQuery schema initialisation (run once at provisioning)
// Creates the venueflow_analytics dataset and all required tables idempotently.
// ─────────────────────────────────────────────────────────────────────────

/**
 * HTTP Cloud Function — idempotent BigQuery schema setup.
 * Creates the dataset and four tables (zone_snapshots, incidents,
 * fan_sentiment, daily_aggregations) if they do not already exist.
 *
 * @type {CloudFunction<Request, Response>}
 */
exports.initBigQuerySchema = onRequest(
  { region: REGION, cors: false },
  async (_req, res) => {
    const results = {};

    // Create dataset if missing
    const [existing] = await bigquery.getDatasets();
    if (!existing.find(d => d.id === DATASET_ID)) {
      await bigquery.createDataset(DATASET_ID, { location: 'US' });
      results.dataset = 'created';
    } else {
      results.dataset = 'exists';
    }

    const ds = bigquery.dataset(DATASET_ID);

    const createTable = async (name, schema) => {
      await ds.createTable(name, { schema })
        .then(() => { results[name] = 'created'; })
        .catch(err => { results[name] = err.code === 409 ? 'exists' : `error: ${err.message}`; });
    };

    await createTable(TBL_ZONES, [
      { name: 'zone_id',      type: 'STRING',    mode: 'REQUIRED' },
      { name: 'zone_name',    type: 'STRING',    mode: 'NULLABLE' },
      { name: 'density_pct',  type: 'INTEGER',   mode: 'REQUIRED' },
      { name: 'wait_minutes', type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'status',       type: 'STRING',    mode: 'NULLABLE' },
      { name: 'venue',        type: 'STRING',    mode: 'NULLABLE' },
      { name: 'match_day',    type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'timestamp',    type: 'TIMESTAMP', mode: 'REQUIRED' },
    ]);

    await createTable(TBL_INC, [
      { name: 'incident_id', type: 'STRING',    mode: 'REQUIRED' },
      { name: 'title',       type: 'STRING',    mode: 'NULLABLE' },
      { name: 'type',        type: 'STRING',    mode: 'NULLABLE' },
      { name: 'location',    type: 'STRING',    mode: 'NULLABLE' },
      { name: 'severity',    type: 'STRING',    mode: 'NULLABLE' },
      { name: 'venue',       type: 'STRING',    mode: 'NULLABLE' },
      { name: 'is_new',      type: 'BOOLEAN',   mode: 'NULLABLE' },
      { name: 'resolved',    type: 'BOOLEAN',   mode: 'NULLABLE' },
      { name: 'timestamp',   type: 'TIMESTAMP', mode: 'REQUIRED' },
    ]);

    await createTable(TBL_SENT, [
      { name: 'text',        type: 'STRING',  mode: 'NULLABLE' },
      { name: 'score',       type: 'FLOAT',   mode: 'NULLABLE' },
      { name: 'magnitude',   type: 'FLOAT',   mode: 'NULLABLE' },
      { name: 'label',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'venue',       type: 'STRING',  mode: 'NULLABLE' },
      { name: 'timestamp',   type: 'TIMESTAMP', mode: 'REQUIRED' },
    ]);

    await createTable(TBL_AGG, [
      { name: 'venue',             type: 'STRING',    mode: 'NULLABLE' },
      { name: 'match_day',         type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'avg_density',       type: 'FLOAT',     mode: 'NULLABLE' },
      { name: 'peak_density',      type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'avg_wait',          type: 'FLOAT',     mode: 'NULLABLE' },
      { name: 'peak_wait',         type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'total_incidents',   type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'total_zone_events', type: 'INTEGER',   mode: 'NULLABLE' },
      { name: 'aggregated_at',     type: 'TIMESTAMP', mode: 'REQUIRED' },
    ]);

    console.log('[BigQuery] Schema init complete:', results);
    res.json({ status: 'ok', results });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// 7. HTTP ENDPOINT — Pub/Sub zone alert broadcast
// Allows the frontend to trigger a Pub/Sub message for any zone.
// ─────────────────────────────────────────────────────────────────────────

/**
 * HTTP Cloud Function — manual Pub/Sub zone alert trigger.
 * Accepts POST { zoneId, density, severity } and publishes to the
 * zone-density-alerts topic so all subscribers receive instant updates.
 *
 * @type {CloudFunction<Request, Response>}
 */
exports.publishZoneAlert = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const { zoneId, density, severity = 'info' } = req.body;
    if (!zoneId) return res.status(400).json({ error: '`zoneId` required' });

    const message = { zoneId, density, severity, venue: 'wembley', ts: new Date().toISOString() };
    const topic   = pubSubClient.topic(TOPIC);
    const [msgId] = await topic.publishMessage({
      data:       Buffer.from(JSON.stringify(message)),
      attributes: { severity, zoneId },
    });

    console.log(`[Pub/Sub] Zone alert published — ${zoneId} (${severity}), msgId: ${msgId}`);
    res.json({ messageId: msgId, topic: TOPIC, zoneId, severity });
  }
);
