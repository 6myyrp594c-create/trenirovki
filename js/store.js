(function () {
  var KEY = "workout-tracker-v1";

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function blank() {
    return { workouts: [], sessions: [] };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.workouts) || !Array.isArray(data.sessions)) return blank();
      return data;
    } catch (err) {
      return blank();
    }
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  window.WorkoutStore = { uid: uid, load: load, save: save, blank: blank };
})();
