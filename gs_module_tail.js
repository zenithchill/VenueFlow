// ───────────────
// FIREBASE: ANALYTICS & PERFORMANCE
// ───────────────
function _initAnalyticsAndPerf() {
  // Exposed tracking for the rest of the application
  window._logAnalyticsEvent = function(eventName, eventParams = {}) {
    if (window.VF_ANALYTICS) {
      window.VF_ANALYTICS.logEvent(eventName, eventParams);
    }
  };

  window._updateAnalyticsCounter = function(elementId, incrementValue) {
    const el = document.getElementById(elementId);
    if (el) {
      const current = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
      el.textContent = (current + incrementValue).toLocaleString();
    }
  };

  window._createPerfTrace = function(traceName) {
    if (window.VF_PERF) {
      return window.VF_PERF.trace(traceName);
    }
    return { start: () => {}, stop: () => {}, putAttribute: () => {} };
  };

  // Setup unhandled error tracking
  window.addEventListener('error', function(event) {
    window._logAnalyticsEvent('exception', {
      description: event.message,
      fatal: true
    });
  });

  // Track initial page load performance
  if (window.performance) {
    const pageLoadTrace = window._createPerfTrace('page_load_timing');
    pageLoadTrace.start();
    window.addEventListener('load', () => {
      setTimeout(() => {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        pageLoadTrace.putAttribute('load_time_ms', pageLoadTime.toString());
        pageLoadTrace.stop();
        
        // Update performance metric on dashboard
        const perfEl = document.getElementById('ana-perf-score');
        if (perfEl) perfEl.textContent = pageLoadTime + 'ms';
      }, 0);
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// INITIALIZE ALL EXTENDED SERVICES
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Firebase extensions
  _initFirestoreSync();
  _initFCM();
  _initAnalyticsAndPerf();
  
  // Attach click listener for FCM requests to Attendee bell icon
  const notifBtn = document.getElementById('fcm-notif-btn');
  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      if (Notification.permission === 'default') {
        _initFCM();
      }
    });
  }
  
  // Set up mock auth users count update
  setInterval(() => {
    window._updateAnalyticsCounter('ana-auth-users', Math.floor(Math.random() * 3));
    window._updateAnalyticsCounter('ana-active-users', Math.floor(Math.random() * 5) - 2);
  }, 15000);
});
