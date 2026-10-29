(function () {
  var FRESH_MS = 6 * 60 * 60 * 1000;
  var REST_PRESETS = [60, 90, 120, 180];
  var DURATION_PRESETS = [0, 30, 45, 60, 90, 120];

  var state = WorkoutStore.load();
  var ui = { route: parseRoute(), sheet: null, dialog: null };
  var timer = {
    phase: "idle",
    mode: null,
    title: "",
    totalMs: 0,
    endsAt: 0,
    paused: false,
    remainingMs: 0,
    pushId: ""
  };
  var audioCtx = null;
  var wakeLock = null;
  var toastTimer = null;

  function uid() { return WorkoutStore.uid(); }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function icon(name) {
    var paths = {
      back: '<path d="M15 5 7 12l8 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
      chevron: '<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
      list: '<path d="M8 7h11M8 12h11M8 17h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4.5" cy="7" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17" r="1" fill="currentColor"/>',
      clock: '<circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.5V12l2.5 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    };
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + "</svg>";
  }

  function persist() {
    try {
      WorkoutStore.save(state);
    } catch (err) {
      toast("Не удалось сохранить данные на устройстве");
    }
  }

  function toast(text) {
    var el = document.getElementById("toast");
    el.hidden = false;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function parseRoute() {
    var parts = (location.hash || "").replace(/^#/, "").split("/").filter(Boolean);
    if (parts[0] === "w" && parts[1]) return { name: "workout", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "history" && parts[1]) return { name: "history", workoutId: decodeURIComponent(parts[1]) };
    if (parts[0] === "history") return { name: "history", workoutId: null };
    if (parts[0] === "s" && parts[1]) return { name: "session", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "settings") return { name: "settings" };
    return { name: "home" };
  }

  function findWorkout(id) {
    return state.workouts.find(function (w) { return w.id === id; }) || null;
  }

  function findSession(id) {
    return state.sessions.find(function (s) { return s.id === id; }) || null;
  }

  function findExercise(exId) {
    for (var i = 0; i < state.workouts.length; i++) {
      var ex = state.workouts[i].exercises.find(function (item) { return item.id === exId; });
      if (ex) return { workout: state.workouts[i], exercise: ex };
    }
    return null;
  }

  function cloneExercises(list) {
    return (list || []).map(function (ex) {
      return {
        id: ex.id,
        name: ex.name,
        durationSec: ex.durationSec || 0,
        sets: (ex.sets || []).map(function (s) {
          return { id: s.id, reps: s.reps, weight: s.weight, restSec: s.restSec || 0 };
        })
      };
    });
  }

  function signature(exercises) {
    return JSON.stringify((exercises || []).map(function (ex) {
      return {
        n: String(ex.name || "").trim(),
        d: ex.durationSec || 0,
        s: (ex.sets || []).map(function (s) { return [s.reps == null ? null : s.reps, s.weight == null ? null : s.weight, s.restSec || 0]; })
      };
    }));
  }

  function volume(exercises) {
    var sum = 0;
    (exercises || []).forEach(function (ex) {
      (ex.sets || []).forEach(function (s) {
        sum += (Number(s.weight) || 0) * (Number(s.reps) || 0);
      });
    });
    return Math.round(sum);
  }

  function sessionList(workoutId) {
    return state.sessions
      .filter(function (s) { return !workoutId || s.workoutId === workoutId; })
      .slice()
      .sort(function (a, b) { return b.performedAt - a.performedAt; });
  }

  function memoryFor(workoutId) {
    var list = sessionList(workoutId);
    if (!list.length) return { kind: "none", session: null, latest: null };
    var latest = list[0];
    var fresh = Date.now() - latest.performedAt < FRESH_MS;
    if (fresh && list[1]) return { kind: "previous", session: list[1], latest: latest };
    if (fresh) return { kind: "today-only", session: null, latest: latest };
    return { kind: "previous", session: latest, latest: latest };
  }

  function matchExercise(session, exercise) {
    if (!session) return null;
    return session.exercises.find(function (e) { return e.id === exercise.id; })
      || session.exercises.find(function (e) {
        return String(e.name || "").trim().toLowerCase() === String(exercise.name || "").trim().toLowerCase();
      })
      || null;
  }

  function roundWeight(n) { return Math.round(n * 100) / 100; }

  function clampWeight(n) {
    if (n == null || !isFinite(n)) return null;
    return Math.min(999, Math.max(0, roundWeight(n)));
  }

  function clampReps(n) {
    if (n == null || !isFinite(n)) return null;
    return Math.min(999, Math.max(0, Math.round(n)));
  }

  function clampSec(n, max) {
    if (n == null || !isFinite(n)) return 0;
    return Math.min(max, Math.max(0, Math.round(n)));
  }

  function parseNum(value) {
    var s = String(value == null ? "" : value).trim().replace(",", ".");
    if (!s) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function numToInput(n) {
    if (n == null || n === "") return "";
    return String(n).replace(".", ",");
  }

  function formatWeight(n) {
    if (n == null || n === "") return "—";
    var x = Number(n);
    if (!isFinite(x)) return "—";
    var rounded = roundWeight(x);
    return String(rounded).replace(".", ",");
  }

  function formatInt(n) { return Math.round(n).toLocaleString("ru-RU"); }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function formatFullDate(ts) {
    return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function dayGroupLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (isSameDay(d, today)) return "Сегодня";
    if (isSameDay(d, yesterday)) return "Вчера";
    if (d.getFullYear() === today.getFullYear()) return formatFullDate(ts);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  }

  function weightDelta(current, previous) {
    if (current == null || previous == null) return null;
    var d = roundWeight(Number(current) - Number(previous));
    if (!d) return null;
    return d;
  }

  function formatDelta(d) {
    var abs = formatWeight(Math.abs(d));
    return (d > 0 ? "+" : "−") + abs;
  }

  function recordInfo(w) {
    var latest = sessionList(w.id)[0] || null;
    var fresh = latest && Date.now() - latest.performedAt < FRESH_MS;
    var same = latest && signature(latest.exercises) === signature(w.exercises);
    if (!w.exercises.length) {
      return { hidden: true, label: "", disabled: true, status: "" };
    }
    if (!latest) {
      return { hidden: false, label: "Записать тренировку", disabled: false, status: "После записи этот вес станет прошлым" };
    }
    if (fresh && same) {
      return { hidden: false, label: "Записано", disabled: true, status: "Сегодня в " + formatTime(latest.performedAt) };
    }
    if (fresh && !same) {
      return { hidden: false, label: "Обновить запись", disabled: false, status: "Правка попадёт в сегодняшнюю запись" };
    }
    return { hidden: false, label: "Записать тренировку", disabled: false, status: "Прошлый раз " + formatFullDate(latest.performedAt) };
  }

  function sessionTitle(s) {
    var w = findWorkout(s.workoutId);
    return w ? w.name : (s.workoutName || "Тренировка");
  }

  function go(hash) {
    if (location.hash === hash) render({ scroll: 0 });
    else location.hash = hash;
  }

  function createWorkout(name) {
    var now = Date.now();
    var workout = { id: uid(), name: name.slice(0, 80), createdAt: now, updatedAt: now, exercises: [] };
    state.workouts.push(workout);
    persist();
    go("#/w/" + encodeURIComponent(workout.id));
  }

  function addExercise(workoutId, name) {
    var w = findWorkout(workoutId);
    if (!w) return;
    if (w.exercises.length >= 40) { toast("Слишком много упражнений"); return; }
    w.exercises.push({
      id: uid(),
      name: name.slice(0, 80),
      durationSec: 0,
      sets: [{ id: uid(), reps: 8, weight: null, restSec: 90 }]
    });
    w.updatedAt = Date.now();
    persist();
    render();
  }

  function addSet(exId) {
    var found = findExercise(exId);
    if (!found) return;
    var sets = found.exercise.sets;
    if (sets.length >= 20) { toast("Слишком много подходов"); return; }
    var prev = sets[sets.length - 1];
    sets.push({
      id: uid(),
      reps: prev ? prev.reps : 8,
      weight: prev ? prev.weight : null,
      restSec: prev ? prev.restSec : 90
    });
    found.workout.updatedAt = Date.now();
    persist();
    render();
  }

  function bump(exId, setId, field, step) {
    var found = findExercise(exId);
    if (!found) return;
    var delta = Number(step);
    if (field === "duration") {
      found.exercise.durationSec = clampSec((found.exercise.durationSec || 0) + delta, 90 * 60);
    } else {
      var set = found.exercise.sets.find(function (s) { return s.id === setId; });
      if (!set) return;
      if (field === "weight") set.weight = clampWeight((set.weight == null ? 0 : Number(set.weight)) + delta);
      if (field === "reps") set.reps = clampReps((set.reps == null ? 0 : Number(set.reps)) + delta);
      if (field === "rest") set.restSec = clampSec((set.restSec || 0) + delta, 30 * 60);
    }
    found.workout.updatedAt = Date.now();
    persist();
    render();
  }

  function applyInput(el) {
    var found = findExercise(el.dataset.ex);
    if (!found) return;
    var field = el.dataset.field;
    var empty = el.value.trim() === "";
    var num = parseNum(el.value);
    if (field === "weight" || field === "reps") {
      var set = found.exercise.sets.find(function (s) { return s.id === el.dataset.set; });
      if (!set) return;
      if (empty) {
        if (field === "weight") set.weight = null;
        if (field === "reps") set.reps = null;
      } else if (num == null) {
        return;
      } else if (field === "weight") {
        set.weight = clampWeight(num);
      } else {
        set.reps = clampReps(num);
      }
      patchMemory(found.exercise, set);
    }
    found.workout.updatedAt = Date.now();
    persist();
    refreshRecordButton(found.workout);
  }

  function formatField(el) {
    if (!document.body.contains(el)) return;
    var found = findExercise(el.dataset.ex);
    if (!found) return;
    if (el.dataset.field === "weight") {
      var set = found.exercise.sets.find(function (s) { return s.id === el.dataset.set; });
      if (set) el.value = numToInput(set.weight);
    }
    if (el.dataset.field === "reps") {
      var repsSet = found.exercise.sets.find(function (s) { return s.id === el.dataset.set; });
      if (repsSet) el.value = repsSet.reps == null ? "" : String(repsSet.reps);
    }
  }

  function patchMemory(exercise, set) {
    var found = findExercise(exercise.id);
    if (!found) return;
    var mem = memoryFor(found.workout.id);
    var memEx = matchExercise(mem.session || mem.latest, found.exercise);
    var index = found.exercise.sets.findIndex(function (item) { return item.id === set.id; });
    var memSet = memEx && memEx.sets[index];
    var deltaNode = document.querySelector('[data-delta="' + set.id + '"]');
    if (deltaNode) {
      var delta = memSet ? weightDelta(set.weight, memSet.weight) : null;
      deltaNode.textContent = delta == null ? "" : formatDelta(delta);
      deltaNode.className = "delta" + (delta != null && delta < 0 ? " down" : "");
    }
    var restore = document.querySelector('[data-restore="' + set.id + '"]');
    if (restore) restore.hidden = !loadsDiffer(set, memSet);
  }

  function loadsDiffer(set, memSet) {
    if (!set || !memSet) return false;
    return Number(set.weight) !== Number(memSet.weight) || Number(set.reps) !== Number(memSet.reps);
  }

  function refreshRecordButton(w) {
    var info = recordInfo(w);
    var btn = document.getElementById("record-btn");
    var status = document.getElementById("record-status");
    if (btn) {
      btn.textContent = info.label;
      btn.disabled = info.disabled;
      btn.hidden = info.hidden;
    }
    if (status) status.textContent = info.status;
  }

  function useMemory(exId, setId) {
    var found = findExercise(exId);
    if (!found) return;
    var mem = memoryFor(found.workout.id);
    var memEx = matchExercise(mem.session || mem.latest, found.exercise);
    var index = found.exercise.sets.findIndex(function (s) { return s.id === setId; });
    var memSet = memEx && memEx.sets[index];
    if (!memSet) return;
    found.exercise.sets[index].weight = memSet.weight;
    found.exercise.sets[index].reps = memSet.reps;
    found.workout.updatedAt = Date.now();
    persist();
    render();
  }

  function recordWorkout(workoutId) {
    var w = findWorkout(workoutId);
    if (!w || !w.exercises.length) {
      toast("Сначала добавьте упражнение");
      return;
    }
    var list = sessionList(workoutId);
    var snapshot = cloneExercises(w.exercises);
    var now = Date.now();
    var latest = list[0];
    if (latest && now - latest.performedAt < FRESH_MS) {
      if (signature(latest.exercises) === signature(snapshot)) {
        toast("Эта тренировка уже записана");
        return;
      }
      latest.exercises = snapshot;
      latest.workoutName = w.name;
      latest.updatedAt = now;
      w.updatedAt = now;
      persist();
      toast("Запись обновлена");
      render();
      return;
    }
    state.sessions.push({
      id: uid(),
      workoutId: w.id,
      workoutName: w.name,
      performedAt: now,
      updatedAt: now,
      exercises: snapshot
    });
    w.updatedAt = now;
    persist();
    toast("Тренировка записана");
    render();
  }

  function saveTimer() {
    try { sessionStorage.removeItem("wt-timer"); } catch (err) {}
    if (timer.phase === "idle") {
      localStorage.removeItem("wt-timer");
      return;
    }
    localStorage.setItem("wt-timer", JSON.stringify(timer));
  }

  function remainingMs() {
    if (timer.phase !== "run") return 0;
    if (timer.paused) return timer.remainingMs;
    return Math.max(0, timer.endsAt - Date.now());
  }

  function paintTimer() {
    var label = document.getElementById("timer-remaining");
    var bar = document.getElementById("timer-progress");
    syncTitle();
    if (!label) return;
    var left = remainingMs();
    label.textContent = formatDuration(Math.ceil(left / 1000));
    if (bar && timer.totalMs) bar.style.transform = "scaleX(" + Math.max(0, Math.min(1, left / timer.totalMs)) + ")";
  }

  async function lockWake() {
    if (!navigator.wakeLock || timer.phase !== "run" || timer.paused) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (err) { wakeLock = null; }
  }

  function releaseWake() {
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (err) {}
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      [880, 1175].forEach(function (freq, index) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var start = audioCtx.currentTime + index * 0.18;
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.3);
      });
    } catch (err) {}
    if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 180]);
  }

  var pushSeq = 0;
  var swReady = null;

  function pushConfig() {
    var cfg = window.PUSH_CONFIG;
    if (!cfg || !cfg.publicKey || !cfg.endpoint) return null;
    return cfg;
  }

  function urlBase64ToUint8Array(value) {
    var padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    var raw = atob(padded);
    var out = new Uint8Array(raw.length);
    var i;
    for (i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function warmSw() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    swReady = navigator.serviceWorker.register("./sw.js").then(function () {
      return navigator.serviceWorker.ready;
    });
    swReady.catch(function () { swReady = null; });
  }

  function subscribePush(forcePrompt) {
    var cfg = pushConfig();
    if (!cfg || !("PushManager" in window) || !("serviceWorker" in navigator)) return Promise.resolve(null);
    if (!forcePrompt && (typeof Notification === "undefined" || Notification.permission !== "granted")) return Promise.resolve(null);
    var pending = swReady || navigator.serviceWorker.ready;
    return Promise.resolve(pending).then(function (reg) {
      if (!reg || !reg.pushManager) return null;
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.publicKey)
        });
      });
    });
  }

  function remoteCopy() {
    var next = timer.queue ? timer.queue[timer.queueIndex + 1] : null;
    if (timer.mode === "rest") {
      var restBody = "Можно продолжать";
      if (next) restBody = next.mode === "work" ? "Дальше: " + next.title : (next.detail || "Дальше");
      return { title: "Отдых закончился", body: restBody };
    }
    if (next) {
      var label = next.detail ? next.detail + " · " + next.title : next.title;
      return { title: "Время вышло", body: "Дальше: " + label };
    }
    return { title: "Время вышло", body: timer.mode === "work" ? "Упражнение закончилось" : "Можно продолжать" };
  }

  function postPush(path, payload) {
    var cfg = pushConfig();
    if (!cfg) return Promise.resolve();
    return fetch(cfg.endpoint.replace(/\/$/, "") + path, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    });
  }

  function cancelRemote() {
    pushSeq += 1;
    var id = timer.pushId;
    timer.pushId = "";
    if (id) postPush("/cancel", { id: id }).catch(function () {});
  }

  function armRemote() {
    if (!pushConfig() || timer.phase !== "run" || timer.paused) return;
    var seq = ++pushSeq;
    var previous = timer.pushId;
    var id = uid();
    var copy = remoteCopy();
    var fireAt = timer.endsAt;
    timer.pushId = id;
    saveTimer();
    if (previous && previous !== id) postPush("/cancel", { id: previous }).catch(function () {});
    subscribePush(false).then(function (sub) {
      if (seq !== pushSeq || !sub) return;
      return postPush("/schedule", {
        id: id,
        fireAt: fireAt,
        title: copy.title,
        body: copy.body,
        subscription: sub.toJSON()
      });
    }).catch(function () {});
  }

  function askNotify(manual) {
    unlockAudio();
    if (!pushConfig() || !("PushManager" in window)) {
      if (typeof Notification === "undefined" || Notification.permission !== "default") return;
      try {
        var legacy = Notification.requestPermission();
        if (legacy && legacy.then) legacy.then(function () { render(); }).catch(function () {});
      } catch (err) {}
      return;
    }
    subscribePush(true).then(function () {
      if (timer.phase === "run" && !timer.paused) armRemote();
      render();
    }).catch(function () {
      if (manual) toast("Не удалось включить уведомления. На айфоне откройте иконку на экране «Домой».");
      render();
    });
  }

  function fallbackNotify(title, body) {
    try {
      var note = new Notification(title, { body: body, tag: "workout-rest" });
      setTimeout(function () { try { note.close(); } catch (e) {} }, 8000);
    } catch (err) {}
  }

  function notify(title, body) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    var options = { body: body, tag: "workout-rest", renotify: true };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg && reg.showNotification) {
          reg.showNotification(title, options).catch(function () { fallbackNotify(title, body); });
        } else fallbackNotify(title, body);
      }).catch(function () { fallbackNotify(title, body); });
      return;
    }
    fallbackNotify(title, body);
  }

  function clearQueue() {
    timer.queue = null;
    timer.queueIndex = 0;
    timer.workoutId = null;
    timer.doneTitle = "";
  }

  function syncTitle() {
    if (timer.phase !== "run") {
      document.title = "Тренировки";
      return;
    }
    var label = timer.mode === "rest" ? "Отдых" : "Упражнение";
    document.title = formatDuration(Math.ceil(remainingMs() / 1000)) + " · " + label;
  }

  function startTimer(mode, seconds, title) {
    unlockAudio();
    askNotify(false);
    clearQueue();
    var ms = Math.max(1, Math.round(seconds) * 1000);
    timer.phase = "run";
    timer.mode = mode;
    timer.title = title;
    timer.totalMs = ms;
    timer.endsAt = Date.now() + ms;
    timer.paused = false;
    timer.remainingMs = ms;
    saveTimer();
    lockWake();
    armRemote();
    render();
  }

  function runQueueStep(index) {
    var step = timer.queue && timer.queue[index];
    if (!step) return;
    var ms = Math.max(1, Math.round(step.seconds) * 1000);
    timer.queueIndex = index;
    timer.phase = "run";
    timer.mode = step.mode;
    timer.title = step.detail ? step.detail + " · " + step.title : step.title;
    timer.totalMs = ms;
    timer.endsAt = Date.now() + ms;
    timer.paused = false;
    timer.remainingMs = ms;
    timer.doneTitle = "";
    saveTimer();
    lockWake();
    armRemote();
    render();
    requestAnimationFrame(function () {
      var node = document.querySelector(".exercise.current");
      if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
    });
  }

  function startCircuit(workoutId) {
    var w = findWorkout(workoutId);
    if (!w || !w.circuit) return;
    if (!w.exercises.length) { toast("Сначала добавьте упражнение"); return; }
    var missing = w.exercises.filter(function (ex) { return !ex.durationSec; });
    if (missing.length) {
      toast("Задайте время упражнения: " + missing[0].name);
      return;
    }
    askNotify(false);
    unlockAudio();
    var rounds = Math.min(20, Math.max(1, Number(w.circuit.rounds) || 1));
    var rest = clampSec(Number(w.circuit.restSec) || 0, 15 * 60);
    var steps = [];
    var round;
    var index;
    for (round = 1; round <= rounds; round++) {
      for (index = 0; index < w.exercises.length; index++) {
        var ex = w.exercises[index];
        var last = round === rounds && index === w.exercises.length - 1;
        var nextEx = w.exercises[index + 1] || (round < rounds ? w.exercises[0] : null);
        steps.push({
          mode: "work",
          seconds: ex.durationSec,
          title: ex.name,
          detail: "Круг " + round + " из " + rounds,
          exerciseId: ex.id
        });
        if (!last && rest > 0) {
          steps.push({
            mode: "rest",
            seconds: rest,
            title: "Отдых",
            detail: nextEx ? "Дальше: " + nextEx.name : "Отдых",
            exerciseId: nextEx ? nextEx.id : ""
          });
        }
      }
    }
    timer.queue = steps;
    timer.workoutId = w.id;
    runQueueStep(0);
  }

  function skipStep() {
    if (timer.phase !== "run" || !timer.queue) return;
    var next = timer.queueIndex + 1;
    if (next >= timer.queue.length) {
      timer.doneTitle = "Круговая закончена";
      stopTimer(false);
      toast("Круговая закончена");
      return;
    }
    unlockAudio();
    runQueueStep(next);
  }

  function pauseTimer() {
    if (timer.phase !== "run") return;
    if (timer.paused) {
      timer.paused = false;
      timer.endsAt = Date.now() + timer.remainingMs;
      lockWake();
      saveTimer();
      armRemote();
    } else {
      timer.paused = true;
      timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
      releaseWake();
      cancelRemote();
      saveTimer();
    }
    render();
  }

  function addTimerSeconds(sec) {
    if (timer.phase !== "run") return;
    var extra = sec * 1000;
    timer.totalMs += extra;
    if (timer.paused) timer.remainingMs += extra;
    else timer.endsAt += extra;
    saveTimer();
    if (!timer.paused) armRemote();
    paintTimer();
  }

  function stopTimer(silent) {
    cancelRemote();
    timer.phase = "idle";
    timer.mode = null;
    clearQueue();
    releaseWake();
    saveTimer();
    syncTitle();
    if (!silent) render();
  }

  var completing = false;

  function completeTimer() {
    if (timer.phase !== "run" || completing) return;
    completing = true;
    var late = Date.now() - timer.endsAt;
    cancelRemote();
    var finishedMode = timer.mode;
    var nextStep = timer.queue ? timer.queue[timer.queueIndex + 1] : null;
    var wasCircuit = !!timer.queue;
    beep();
    if (finishedMode === "rest" && late < 1500) {
      var body = "Можно продолжать";
      if (nextStep) body = nextStep.mode === "work" ? "Дальше: " + nextStep.title : (nextStep.detail || "Дальше");
      notify("Отдых закончился", body);
      toast("Отдых закончился");
    }
    if (nextStep) {
      runQueueStep(timer.queueIndex + 1);
      completing = false;
      return;
    }
    timer.phase = "done";
    timer.paused = false;
    timer.remainingMs = 0;
    timer.doneTitle = wasCircuit ? "Круговая закончена" : (finishedMode === "rest" ? "Отдых закончился" : "Время упражнения вышло");
    timer.queue = null;
    timer.queueIndex = 0;
    releaseWake();
    saveTimer();
    syncTitle();
    if (finishedMode !== "rest") toast(timer.doneTitle);
    render();
    completing = false;
    setTimeout(function () {
      if (timer.phase === "done") stopTimer(false);
    }, 4000);
  }

  function restoreTimer() {
    try {
      var raw = localStorage.getItem("wt-timer") || sessionStorage.getItem("wt-timer");
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || saved.phase === "idle" || saved.phase === "done") return;
      timer = saved;
      if (!timer.pushId) timer.pushId = "";
      if (!timer.paused && timer.endsAt <= Date.now()) {
        if (Date.now() - timer.endsAt < 15 * 60 * 1000) setTimeout(function () { completeTimer(); }, 0);
        else {
          stopTimer(true);
          toast("Таймер уже закончился");
        }
        return;
      }
      if (!timer.paused) lockWake();
    } catch (err) {
      localStorage.removeItem("wt-timer");
      sessionStorage.removeItem("wt-timer");
    }
  }

  function exportData() {
    var payload = { version: 1, exportedAt: new Date().toISOString(), workouts: state.workouts, sessions: state.sessions };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var day = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "trenerovki-" + day + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Файл сохранён");
  }

  function sanitizeExercise(ex) {
    if (!ex || !ex.id) return null;
    var sets = Array.isArray(ex.sets) ? ex.sets.map(function (s) {
      if (!s || !s.id) return null;
      return {
        id: String(s.id),
        reps: s.reps == null ? null : clampReps(Number(s.reps)),
        weight: s.weight == null ? null : clampWeight(Number(s.weight)),
        restSec: clampSec(Number(s.restSec) || 0, 30 * 60)
      };
    }).filter(Boolean) : [];
    return {
      id: String(ex.id),
      name: String(ex.name || "Упражнение").trim().slice(0, 80) || "Упражнение",
      durationSec: clampSec(Number(ex.durationSec) || 0, 90 * 60),
      sets: sets
    };
  }

  function sanitizeWorkout(w) {
    if (!w || !w.id) return null;
    return {
      id: String(w.id),
      name: String(w.name || "Тренировка").trim().slice(0, 80) || "Тренировка",
      createdAt: Number(w.createdAt) || Date.now(),
      updatedAt: Number(w.updatedAt) || Date.now(),
      exercises: Array.isArray(w.exercises) ? w.exercises.map(sanitizeExercise).filter(Boolean) : [],
      circuit: w.circuit ? {
        rounds: Math.min(20, Math.max(1, Math.round(Number(w.circuit.rounds) || 3))),
        restSec: clampSec(Number(w.circuit.restSec) || 0, 15 * 60)
      } : null
    };
  }

  function sanitizeSession(s) {
    if (!s || !s.id || !s.workoutId) return null;
    return {
      id: String(s.id),
      workoutId: String(s.workoutId),
      workoutName: String(s.workoutName || "Тренировка").slice(0, 80),
      performedAt: Number(s.performedAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Number(s.performedAt) || Date.now(),
      exercises: Array.isArray(s.exercises) ? s.exercises.map(sanitizeExercise).filter(Boolean) : []
    };
  }

  function applyImport(data, replace) {
    var workouts = (data.workouts || []).map(sanitizeWorkout).filter(Boolean);
    var sessions = (data.sessions || []).map(sanitizeSession).filter(Boolean);
    if (replace) {
      state = { workouts: workouts, sessions: sessions };
    } else {
      workouts.forEach(function (w) {
        var index = state.workouts.findIndex(function (item) { return item.id === w.id; });
        if (index >= 0) state.workouts[index] = w;
        else state.workouts.push(w);
      });
      sessions.forEach(function (s) {
        var index = state.sessions.findIndex(function (item) { return item.id === s.id; });
        if (index >= 0) state.sessions[index] = s;
        else state.sessions.push(s);
      });
    }
    persist();
    toast(replace ? "Данные заменены" : "Данные добавлены");
    render();
  }

  function confirmDialog() {
    var d = ui.dialog;
    if (!d) return;
    var input = document.getElementById("dialog-input");
    var value = input ? input.value.trim() : "";
    if (d.intent === "create-workout" || d.intent === "rename-workout" || d.intent === "create-exercise" || d.intent === "rename-exercise") {
      if (!value) { toast("Введите название"); return; }
    }
    ui.dialog = null;
    if (d.intent === "create-workout") { createWorkout(value); return; }
    if (d.intent === "rename-workout") {
      var workout = findWorkout(d.id);
      if (workout) { workout.name = value.slice(0, 80); workout.updatedAt = Date.now(); persist(); }
    }
    if (d.intent === "create-exercise") { addExercise(d.id, value); return; }
    if (d.intent === "rename-exercise") {
      var found = findExercise(d.ex);
      if (found) { found.exercise.name = value.slice(0, 80); found.workout.updatedAt = Date.now(); persist(); }
    }
    if (d.intent === "delete-workout") {
      state.workouts = state.workouts.filter(function (w) { return w.id !== d.id; });
      persist();
      go("#/");
      return;
    }
    if (d.intent === "delete-exercise") {
      var owner = findWorkout(d.id);
      if (owner) {
        owner.exercises = owner.exercises.filter(function (ex) { return ex.id !== d.ex; });
        owner.updatedAt = Date.now();
        persist();
      }
    }
    if (d.intent === "delete-session") {
      var deleted = findSession(d.id);
      var backId = deleted ? deleted.workoutId : "";
      state.sessions = state.sessions.filter(function (s) { return s.id !== d.id; });
      persist();
      go("#/history/" + encodeURIComponent(backId));
      return;
    }
    if (d.intent === "clear-all") {
      state = WorkoutStore.blank();
      persist();
      toast("Данные удалены");
      go("#/");
      return;
    }
    if (d.intent === "import") { applyImport(d.payload, false); return; }
    render();
  }

  function stepper(label, field, valueText, step, exId, setId, deltaHtml) {
    return (
      '<div class="field">' +
        '<div class="field-label"><span>' + label + "</span>" + (deltaHtml || "") + "</div>" +
        '<div class="stepper">' +
          '<button type="button" class="step" data-action="bump" data-field="' + field + '" data-step="' + (-step) + '" data-ex="' + esc(exId) + '" data-set="' + esc(setId || "") + '" aria-label="Меньше">−</button>' +
          (field === "rest" || field === "duration"
            ? '<input value="' + esc(valueText) + '" aria-label="' + esc(label) + '" readonly tabindex="-1">'
            : '<input inputmode="decimal" autocomplete="off" data-field="' + field + '" data-ex="' + esc(exId) + '" data-set="' + esc(setId || "") + '" value="' + esc(valueText) + '" aria-label="' + esc(label) + '">') +
          '<button type="button" class="step" data-action="bump" data-field="' + field + '" data-step="' + step + '" data-ex="' + esc(exId) + '" data-set="' + esc(setId || "") + '" aria-label="Больше">+</button>' +
        "</div>" +
      "</div>"
    );
  }

  function chips(action, current, presets, exId, setId, formatter) {
    return '<div class="chips">' + presets.map(function (sec) {
      var active = Number(current) === sec ? " active" : "";
      return '<button type="button" class="chip' + active + '" data-action="' + action + '" data-sec="' + sec + '" data-ex="' + esc(exId) + '" data-set="' + esc(setId || "") + '">' + formatter(sec) + "</button>";
    }).join("") + "</div>";
  }

  function exerciseCard(workout, exercise) {
    var mem = memoryFor(workout.id);
    var memorySession = mem.session || mem.latest;
    var memEx = matchExercise(memorySession, exercise);
    var header = "Прошлого веса пока нет";
    if (mem.kind === "previous" && memEx) header = "Прошлый раз · " + formatFullDate(mem.session.performedAt);
    else if (mem.kind === "previous") header = "Прошлый раз · " + formatFullDate(mem.session.performedAt) + " · этого упражнения не было";
    else if (mem.kind === "today-only") header = "Записано сегодня в " + formatTime(mem.latest.performedAt);

    var sets = exercise.sets.map(function (set, index) {
      var memSet = memEx && memEx.sets[index] ? memEx.sets[index] : null;
      var delta = memSet ? weightDelta(set.weight, memSet.weight) : null;
      var deltaHtml = '<span class="delta' + (delta != null && delta < 0 ? " down" : "") + '" data-delta="' + esc(set.id) + '">' + (delta == null ? "" : formatDelta(delta)) + "</span>";
      var memoryLine = "";
      if (memSet && (mem.kind === "previous" || loadsDiffer(set, memSet))) {
        var memoryWord = mem.kind === "previous" ? "Было" : "Записано";
        memoryLine = '<p class="memory">' + memoryWord + " <strong>" + formatWeight(memSet.weight) + " кг × " + (memSet.reps == null ? "—" : memSet.reps) + "</strong></p>";
        memoryLine += '<button type="button" class="restore" data-action="use-memory" data-restore="' + esc(set.id) + '" data-ex="' + esc(exercise.id) + '" data-set="' + esc(set.id) + '"' + (loadsDiffer(set, memSet) ? "" : " hidden") + ">Вернуть " + formatWeight(memSet.weight) + "×" + (memSet.reps == null ? "—" : memSet.reps) + "</button>";
      }
      return (
        '<div class="set">' +
          '<div class="set-top"><span class="set-label">Подход ' + (index + 1) + '</span><button type="button" class="linkish" data-action="delete-set" data-ex="' + esc(exercise.id) + '" data-set="' + esc(set.id) + '">Удалить</button></div>' +
          '<div class="fields">' +
            stepper("Вес, кг", "weight", numToInput(set.weight), 2.5, exercise.id, set.id, deltaHtml) +
            stepper("Повторы", "reps", set.reps == null ? "" : String(set.reps), 1, exercise.id, set.id, "") +
          "</div>" +
          '<div class="rest-row"><div class="grow">' +
            stepper("Отдых", "rest", formatDuration(set.restSec || 0), 15, exercise.id, set.id, "") +
            chips("set-rest", set.restSec || 0, REST_PRESETS, exercise.id, set.id, formatDuration) +
          '</div><button type="button" class="btn small amber" data-action="start-rest" data-ex="' + esc(exercise.id) + '" data-set="' + esc(set.id) + '">Старт</button></div>' +
          memoryLine +
        "</div>"
      );
    }).join("");

    var activeStep = timer.phase === "run" && timer.queue ? timer.queue[timer.queueIndex] : null;
    var currentClass = activeStep && activeStep.exerciseId === exercise.id ? " current" : "";
    return (
      '<article class="exercise' + currentClass + '">' +
        '<div class="ex-top"><h2 class="ex-name">' + esc(exercise.name) + '</h2>' +
          '<button type="button" class="icon-btn" data-action="exercise-menu" data-id="' + esc(workout.id) + '" data-ex="' + esc(exercise.id) + '" aria-label="Действия с упражнением">' + icon("more") + "</button></div>" +
        '<p class="memory">' + esc(header) + "</p>" +
        sets +
        '<button type="button" class="add-inline" data-action="add-set" data-ex="' + esc(exercise.id) + '">Добавить подход</button>' +
        '<div class="duration-row"><div class="grow">' +
          stepper("Время упражнения", "duration", formatDuration(exercise.durationSec || 0), 15, exercise.id, "", "") +
          chips("set-duration", exercise.durationSec || 0, DURATION_PRESETS, exercise.id, "", function (sec) { return sec ? formatDuration(sec) : "Выкл"; }) +
        '</div><button type="button" class="btn small" data-action="start-work" data-ex="' + esc(exercise.id) + '"' + (exercise.durationSec ? "" : " disabled") + ">Старт</button></div>" +
      "</article>"
    );
  }

  function viewHome() {
    var workouts = state.workouts.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var list = workouts.length ? '<div class="stack">' + workouts.map(function (w) {
      var last = sessionList(w.id)[0];
      var meta = w.exercises.length + " " + plural(w.exercises.length, "упражнение", "упражнения", "упражнений");
      if (w.circuit) meta = "Круговая · " + w.circuit.rounds + " " + plural(w.circuit.rounds, "круг", "круга", "кругов") + " · " + meta;
      meta += last ? " · последняя " + formatFullDate(last.performedAt) : " · ещё не записывали";
      var preview = w.exercises.length ? esc(w.exercises.slice(0, 3).map(function (e) { return e.name; }).join(" · ")) : "Нет упражнений";
      return '<a class="workout-card" href="#/w/' + encodeURIComponent(w.id) + '"><div class="workout-card-top"><h2>' + esc(w.name) + "</h2>" + icon("chevron") + '</div><p class="meta">' + esc(meta) + '</p><p class="preview">' + preview + "</p></a>";
    }).join("") + "</div>" : (
      '<div class="empty"><div class="hero-mark"></div><h2>Пока пусто</h2><p>Создайте тренировку, например «День ног». В следующий раз здесь будет вес с прошлого раза.</p><button type="button" class="btn primary" data-action="ask-create">Новая тренировка</button></div>'
    );
    var create = workouts.length ? '<button type="button" class="btn primary section-gap" data-action="ask-create">Новая тренировка</button>' : "";
    return (
      '<section class="page"><header class="top"><div><div class="brand"><span class="mark"></span><h1>Тренировки</h1></div><p class="lead">Откройте тренировку — виден вес с прошлого раза, его можно изменить.</p></div><a class="text-link" href="#/settings">Данные</a></header>' +
      list + create + "</section>"
    );
  }

  function circuitStepper(label, field, text, step, workoutId) {
    return (
      '<div class="field"><div class="field-label"><span>' + label + "</span></div>" +
      '<div class="stepper">' +
        '<button type="button" class="step" data-action="bump-circuit" data-field="' + field + '" data-step="' + (-step) + '" data-id="' + esc(workoutId) + '" aria-label="Меньше">−</button>' +
        '<input value="' + esc(text) + '" aria-label="' + label + '" readonly tabindex="-1">' +
        '<button type="button" class="step" data-action="bump-circuit" data-field="' + field + '" data-step="' + step + '" data-id="' + esc(workoutId) + '" aria-label="Больше">+</button>' +
      "</div></div>"
    );
  }

  function circuitCard(w) {
    if (!w.circuit) return "";
    var rounds = w.circuit.rounds || 3;
    var rest = w.circuit.restSec || 0;
    var running = timer.phase === "run" && timer.workoutId === w.id && timer.queue;
    var action = running
      ? '<button type="button" class="btn secondary section-gap" data-action="stop-timer">Остановить</button>'
      : '<button type="button" class="btn primary section-gap" data-action="start-circuit" data-id="' + esc(w.id) + '">Запустить круговую</button>';
    var chipsHtml = [15, 30, 45, 60].map(function (sec) {
      return '<button type="button" class="chip' + (rest === sec ? " active" : "") + '" data-action="set-circuit-rest" data-sec="' + sec + '" data-id="' + esc(w.id) + '">' + formatDuration(sec) + "</button>";
    }).join("");
    return (
      '<article class="exercise circuit-card">' +
        '<h2 class="ex-name">Круговая</h2>' +
        '<p class="memory">Сама переключает упражнения и отдых. В конце отдыха придёт уведомление.</p>' +
        '<div class="fields">' +
          circuitStepper("Круги", "rounds", String(rounds), 1, w.id) +
          circuitStepper("Отдых", "rest", formatDuration(rest), 15, w.id) +
        "</div>" +
        '<div class="chips">' + chipsHtml + "</div>" +
        action +
      "</article>"
    );
  }

  function viewWorkout() {
    var w = findWorkout(ui.route.id);
    if (!w) return missing("Тренировка не найдена");
    var info = recordInfo(w);
    var vol = volume(w.exercises);
    var mem = memoryFor(w.id);
    var sub = w.exercises.length + " " + plural(w.exercises.length, "упражнение", "упражнения", "упражнений");
    if (vol) sub += " · объём " + formatInt(vol) + " кг";
    if (mem.kind === "previous" && volume(mem.session.exercises)) sub += " · прошлый объём " + formatInt(volume(mem.session.exercises)) + " кг";
    var body = circuitCard(w) + (w.exercises.length
      ? w.exercises.map(function (ex) { return exerciseCard(w, ex); }).join("") +
        '<button type="button" class="btn secondary section-gap" data-action="ask-exercise" data-id="' + esc(w.id) + '">Добавить упражнение</button>' +
        '<a class="text-link section-gap" href="#/history/' + encodeURIComponent(w.id) + '">История этой тренировки</a>'
      : '<div class="empty"><h2>Добавьте упражнение</h2><p>У каждого подхода будут вес, повторы и отдых. Для круговой у упражнения нужно время.</p><button type="button" class="btn primary" data-action="ask-exercise" data-id="' + esc(w.id) + '">Добавить упражнение</button></div>');
    var dock = info.hidden ? "" : '<div class="save-dock"><button type="button" class="btn primary" id="record-btn" data-action="record" data-id="' + esc(w.id) + '"' + (info.disabled ? " disabled" : "") + ">" + esc(info.label) + '</button><p class="hint" id="record-status">' + esc(info.status) + "</p></div>";
    return (
      '<section class="page"><div class="back-row"><a href="#/">' + icon("back") + "Тренировки</a></div>" +
      '<header class="top"><div><button type="button" class="title-btn" data-action="rename-workout" data-id="' + esc(w.id) + '">' + esc(w.name) + '</button><p class="subhead">' + esc(sub) + '</p></div>' +
      '<button type="button" class="icon-btn" data-action="workout-menu" data-id="' + esc(w.id) + '" aria-label="Действия с тренировкой">' + icon("more") + "</button></header>" +
      body + "</section>" + dock
    );
  }

  function viewHistory() {
    var list = sessionList(ui.route.workoutId);
    var workout = ui.route.workoutId ? findWorkout(ui.route.workoutId) : null;
    var title = workout ? workout.name : "История";
    var groups = [];
    list.forEach(function (s) {
      var label = dayGroupLabel(s.performedAt);
      var last = groups[groups.length - 1];
      if (!last || last.label !== label) groups.push({ label: label, items: [s] });
      else last.items.push(s);
    });
    var body = list.length ? groups.map(function (group) {
      return '<h2 class="group-label">' + esc(group.label) + "</h2>" + group.items.map(function (s) {
        var names = s.exercises.slice(0, 3).map(function (e) { return e.name; }).join(" · ");
        return '<a class="session-card" href="#/s/' + encodeURIComponent(s.id) + '"><div class="workout-card-top"><h2>' + esc(sessionTitle(s)) + "</h2>" + icon("chevron") + '</div><p class="meta">' + esc(formatTime(s.performedAt) + " · " + formatInt(volume(s.exercises)) + " кг") + '</p><p class="preview">' + esc(names || "Без упражнений") + "</p></a>";
      }).join("");
    }).join("") : '<div class="empty"><h2>Записей пока нет</h2><p>Откройте тренировку и нажмите «Записать тренировку». Здесь останется вес, с которым вы занимались.</p></div>';
    return '<section class="page"><div class="back-row"><a href="' + (workout ? "#/w/" + encodeURIComponent(workout.id) : "#/") + '">' + icon("back") + (workout ? "К тренировке" : "Тренировки") + '</a></div><header class="top"><div><h1>' + esc(title) + '</h1><p class="lead">Прошлые веса и повторы.</p></div></header>' + body + "</section>";
  }

  function viewSession() {
    var s = findSession(ui.route.id);
    if (!s) return missing("Запись не найдена");
    var blocks = s.exercises.map(function (ex) {
      var lines = ex.sets.map(function (set, index) {
        return '<div class="ro-line"><span>Подход ' + (index + 1) + "</span><b>" + formatWeight(set.weight) + " кг × " + (set.reps == null ? "—" : set.reps) + "</b><span>отдых " + formatDuration(set.restSec || 0) + "</span></div>";
      }).join("");
      var duration = ex.durationSec ? '<p class="memory">Время упражнения ' + formatDuration(ex.durationSec) + "</p>" : "";
      return '<article class="exercise"><h2 class="ex-name">' + esc(ex.name) + "</h2>" + duration + lines + "</article>";
    }).join("");
    return (
      '<section class="page"><div class="back-row"><a href="#/history/' + encodeURIComponent(s.workoutId) + '">' + icon("back") + "История</a></div>" +
      '<header class="top"><div><h1>' + esc(sessionTitle(s)) + "</h1><p class=\"lead\">" + esc(dayGroupLabel(s.performedAt) + ", " + formatTime(s.performedAt) + " · объём " + formatInt(volume(s.exercises)) + " кг") + "</p></div></header>" +
      blocks +
      '<button type="button" class="btn danger section-gap" data-action="ask-delete-session" data-id="' + esc(s.id) + '">Удалить запись</button></section>'
    );
  }

  function viewSettings() {
    return (
      '<section class="page"><div class="back-row"><a href="#/">' + icon("back") + "Тренировки</a></div><header class=\"top\"><div><h1>Данные</h1><p class=\"lead\">Копия тренировок хранится только в этом браузере.</p></div></header>" +
      '<div class="stack"><button type="button" class="btn primary" data-action="export">Экспорт в файл</button>' +
      '<label class="btn secondary file-btn">Импорт из файла<input id="import-file" type="file" accept="application/json,.json"></label></div>' +
      '<article class="note section-gap"><strong>Уведомления.</strong> ' + esc(notifyHint()) + '</article>' +
      (typeof Notification !== "undefined" && Notification.permission !== "granted" ? '<button type="button" class="btn secondary section-gap" data-action="ask-notify">Включить уведомления</button>' : "") +
      '<article class="note section-gap"><strong>На айфоне.</strong> Safari → «Поделиться» → «На экран Домой», затем откройте приложение с иконки и разрешите уведомления. Тогда сообщение придёт, даже если приложение закрыто. На сервер уходит только текст этого напоминания, не журнал тренировок. Если очистить данные сайта, тренировки сотрутся — перед этим сделайте экспорт.</article>' +
      '<button type="button" class="btn danger section-gap" data-action="ask-clear">Удалить все данные</button></section>'
    );
  }

  function notifyHint() {
    if (typeof Notification === "undefined") return "Этот браузер не показывает системные уведомления. Сигнал в конце отдыха всё равно прозвучит.";
    if (Notification.permission === "granted") return "Уведомления включены. Сообщение придёт в конце шага, даже если приложение закрыто. На айфоне откройте его с иконки на экране «Домой».";
    if (Notification.permission === "denied") return "Уведомления запрещены. На айфоне разрешите их в Настройках для приложения «Тренировки».";
    return "Разрешите уведомления. На айфоне это работает у иконки на экране «Домой»: сообщение придёт, даже если приложение закрыто.";
  }

  function missing(text) {
    return '<section class="page"><div class="empty"><h2>' + esc(text) + '</h2><a class="btn primary" href="#/">К тренировкам</a></div></section>';
  }

  function plural(n, one, few, many) {
    var n10 = n % 10;
    var n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  function timerDock() {
    if (timer.phase === "idle") return "";
    var left = timer.phase === "done" ? 0 : remainingMs();
    var ratio = timer.totalMs ? Math.max(0, Math.min(1, left / timer.totalMs)) : 0;
    var klass = timer.mode === "rest" ? "rest" : "work";
    if (timer.phase === "done") klass += " done";
    var title = timer.phase === "done"
      ? (timer.doneTitle || (timer.mode === "rest" ? "Отдых закончился" : "Время упражнения вышло"))
      : timer.title;
    var skip = timer.queue && timer.phase === "run"
      ? '<button type="button" class="btn secondary" data-action="skip-step">Дальше</button>'
      : "";
    var actions = timer.phase === "done"
      ? '<button type="button" class="btn secondary" data-action="stop-timer">Закрыть</button>'
      : '<button type="button" class="btn secondary" data-action="add-timer">+30 сек</button>' +
        '<button type="button" class="btn secondary" data-action="pause-timer">' + (timer.paused ? "Продолжить" : "Пауза") + "</button>" +
        skip +
        '<button type="button" class="btn secondary" data-action="stop-timer">Сброс</button>';
    return (
      '<div class="timer-dock ' + klass + '" role="timer">' +
        '<div class="track"><span id="timer-progress" style="transform:scaleX(' + ratio + ')"></span></div>' +
        '<p class="timer-kicker">' + esc(title) + "</p>" +
        '<p class="timer-time" id="timer-remaining">' + formatDuration(Math.ceil(left / 1000)) + "</p>" +
        '<div class="timer-actions">' + actions + "</div></div>"
    );
  }

  function sheetHtml() {
    if (!ui.sheet) return "";
    var items = ui.sheet.actions.map(function (action, index) {
      return '<button type="button" class="menu-item' + (action.danger ? " danger" : "") + '" data-action="sheet-go" data-index="' + index + '">' + esc(action.label) + "</button>";
    }).join("");
    return '<div class="backdrop" data-action="close-overlay"><div class="sheet" role="dialog"><div class="handle"></div><h3>' + esc(ui.sheet.title) + "</h3>" + items + "</div></div>";
  }

  function dialogHtml() {
    var d = ui.dialog;
    if (!d) return "";
    var field = d.input == null ? "" : '<input id="dialog-input" class="dialog-input" data-autofocus maxlength="80" placeholder="' + esc(d.placeholder || "") + '" value="' + esc(d.input) + '" autocapitalize="sentences">';
    var text = d.text ? "<p>" + esc(d.text) + "</p>" : "";
    var alt = d.alt ? '<button type="button" class="btn secondary" data-action="dialog-alt">' + esc(d.alt) + "</button>" : "";
    var confirmClass = d.danger ? "btn danger" : "btn primary";
    return (
      '<div class="backdrop" data-action="close-overlay"><form class="dialog" role="dialog" data-form="dialog">' +
        '<div class="handle"></div><h3>' + esc(d.title) + "</h3>" + text + field +
        '<div class="dialog-actions"><button type="submit" class="' + confirmClass + '">' + esc(d.confirm || "Сохранить") + '</button>' + alt +
        '<button type="button" class="btn secondary" data-action="close-dialog">Отмена</button></div></form></div>'
    );
  }

  function nav() {
    var home = ui.route.name === "home" || ui.route.name === "workout" ? " active" : "";
    var history = ui.route.name === "history" || ui.route.name === "session" ? " active" : "";
    return '<nav class="tabbar"><a class="' + home + '" href="#/"' + (home ? ' aria-current="page"' : "") + ">" + icon("list") + "Тренировки</a><a class=\"" + history + '" href="#/history"' + (history ? ' aria-current="page"' : "") + ">" + icon("clock") + "История</a></nav>";
  }

  function render(opts) {
    opts = opts || {};
    ui.route = parseRoute();
    var y = opts.scroll === 0 ? 0 : window.scrollY;
    var view = ui.route.name === "workout" ? viewWorkout()
      : ui.route.name === "history" ? viewHistory()
      : ui.route.name === "session" ? viewSession()
      : ui.route.name === "settings" ? viewSettings()
      : viewHome();
    document.getElementById("root").innerHTML = '<div class="app">' + view + timerDock() + sheetHtml() + dialogHtml() + nav() + "</div>";
    document.body.classList.toggle("has-save", !!document.querySelector(".save-dock"));
    document.body.classList.toggle("has-timer", timer.phase !== "idle");
    window.scrollTo(0, y);
    var auto = document.querySelector("[data-autofocus]");
    if (auto) {
      auto.focus();
      var len = auto.value.length;
      if (auto.setSelectionRange) auto.setSelectionRange(len, len);
    }
    syncTitle();
    requestAnimationFrame(layoutDocks);
  }

  function layoutDocks() {
    var timerEl = document.querySelector(".timer-dock");
    var saveEl = document.querySelector(".save-dock");
    document.documentElement.style.setProperty("--timer-h", (timerEl ? timerEl.offsetHeight : 0) + "px");
    document.documentElement.style.setProperty("--save-h", (saveEl ? saveEl.offsetHeight : 0) + "px");
  }

  function openSheet(title, actions) {
    ui.sheet = { title: title, actions: actions };
    render();
  }

  function handleAction(action, el) {
    var id = el.dataset.id;
    var exId = el.dataset.ex;
    var setId = el.dataset.set;
    if (action === "ask-create") {
      ui.dialog = { intent: "create-workout", title: "Новая тренировка", input: "", placeholder: "Например, День ног", confirm: "Создать" };
      render();
      return;
    }
    if (action === "rename-workout") {
      var workout = findWorkout(id);
      if (!workout) return;
      ui.dialog = { intent: "rename-workout", title: "Название", input: workout.name, placeholder: "Например, День ног", confirm: "Сохранить", id: id };
      render();
      return;
    }
    if (action === "ask-exercise") {
      ui.dialog = { intent: "create-exercise", title: "Новое упражнение", input: "", placeholder: "Например, Приседания", confirm: "Добавить", id: id };
      render();
      return;
    }
    if (action === "workout-menu") {
      openSheet("Тренировка", [
        { label: "Переименовать", run: function () { handleAction("rename-workout", { dataset: { id: id } }); } },
        { label: findWorkout(id) && findWorkout(id).circuit ? "Обычная тренировка" : "Сделать круговой", run: function () { toggleCircuit(id); } },
        { label: "Удалить тренировку", danger: true, run: function () {
          var w = findWorkout(id);
          ui.dialog = { intent: "delete-workout", title: "Удалить тренировку?", text: "«" + (w ? w.name : "") + "» пропадёт из списка. Записи в истории останутся.", confirm: "Удалить", danger: true, id: id };
          render();
        } }
      ]);
      return;
    }
    if (action === "exercise-menu") {
      openSheet("Упражнение", [
        { label: "Переименовать", run: function () {
          var found = findExercise(exId);
          ui.dialog = { intent: "rename-exercise", title: "Название упражнения", input: found ? found.exercise.name : "", placeholder: "Название", confirm: "Сохранить", ex: exId };
          render();
        } },
        { label: "Выше", run: function () { moveExercise(id, exId, -1); } },
        { label: "Ниже", run: function () { moveExercise(id, exId, 1); } },
        { label: "Удалить упражнение", danger: true, run: function () {
          var found = findExercise(exId);
          ui.dialog = { intent: "delete-exercise", title: "Удалить упражнение?", text: found ? found.exercise.name : "", confirm: "Удалить", danger: true, id: id, ex: exId };
          render();
        } }
      ]);
      return;
    }
    if (action === "sheet-go") {
      var item = ui.sheet && ui.sheet.actions[Number(el.dataset.index)];
      ui.sheet = null;
      if (item) item.run();
      else render();
      return;
    }
    if (action === "close-overlay" || action === "close-dialog") {
      ui.sheet = null;
      ui.dialog = null;
      render();
      return;
    }
    if (action === "dialog-alt" && ui.dialog && ui.dialog.intent === "import") {
      var payload = ui.dialog.payload;
      ui.dialog = null;
      applyImport(payload, true);
      return;
    }
    if (action === "add-set") { addSet(exId); return; }
    if (action === "delete-set") {
      var foundSet = findExercise(exId);
      if (!foundSet) return;
      foundSet.exercise.sets = foundSet.exercise.sets.filter(function (s) { return s.id !== setId; });
      foundSet.workout.updatedAt = Date.now();
      persist();
      render();
      return;
    }
    if (action === "bump") { bump(exId, setId, el.dataset.field, el.dataset.step); return; }
    if (action === "set-rest" || action === "set-duration") {
      var foundPreset = findExercise(exId);
      if (!foundPreset) return;
      var sec = Number(el.dataset.sec);
      if (action === "set-duration") foundPreset.exercise.durationSec = clampSec(sec, 90 * 60);
      else {
        var target = foundPreset.exercise.sets.find(function (s) { return s.id === setId; });
        if (target) target.restSec = clampSec(sec, 30 * 60);
      }
      foundPreset.workout.updatedAt = Date.now();
      persist();
      render();
      return;
    }
    if (action === "use-memory") { useMemory(exId, setId); return; }
    if (action === "record") { recordWorkout(id); return; }
    if (action === "bump-circuit" || action === "set-circuit-rest") {
      var circuitWorkout = findWorkout(id);
      if (!circuitWorkout || !circuitWorkout.circuit) return;
      if (action === "set-circuit-rest") circuitWorkout.circuit.restSec = clampSec(Number(el.dataset.sec), 15 * 60);
      else if (el.dataset.field === "rounds") {
        circuitWorkout.circuit.rounds = Math.min(20, Math.max(1, (circuitWorkout.circuit.rounds || 1) + Number(el.dataset.step)));
      } else {
        circuitWorkout.circuit.restSec = clampSec((circuitWorkout.circuit.restSec || 0) + Number(el.dataset.step), 15 * 60);
      }
      circuitWorkout.updatedAt = Date.now();
      persist();
      render();
      return;
    }
    if (action === "start-circuit") { startCircuit(id); return; }
    if (action === "skip-step") { skipStep(); return; }
    if (action === "ask-notify") { askNotify(true); return; }
    if (action === "start-rest") {
      var restFound = findExercise(exId);
      if (!restFound) return;
      var restSet = restFound.exercise.sets.find(function (s) { return s.id === setId; });
      if (!restSet || !restSet.restSec) { toast("Сначала укажите время отдыха"); return; }
      var index = restFound.exercise.sets.findIndex(function (s) { return s.id === setId; });
      startTimer("rest", restSet.restSec, "Отдых · " + restFound.exercise.name + ", подход " + (index + 1));
      return;
    }
    if (action === "start-work") {
      var workFound = findExercise(exId);
      if (!workFound || !workFound.exercise.durationSec) { toast("Сначала задайте время упражнения"); return; }
      startTimer("work", workFound.exercise.durationSec, "Упражнение · " + workFound.exercise.name);
      return;
    }
    if (action === "pause-timer") { pauseTimer(); return; }
    if (action === "add-timer") { addTimerSeconds(30); return; }
    if (action === "stop-timer") { stopTimer(false); return; }
    if (action === "export") { exportData(); return; }
    if (action === "ask-delete-session") {
      ui.dialog = { intent: "delete-session", title: "Удалить запись?", text: "Прошлый вес из этой записи больше не будет подставляться, если это была последняя тренировка.", confirm: "Удалить", danger: true, id: id };
      render();
      return;
    }
    if (action === "ask-clear") {
      ui.dialog = { intent: "clear-all", title: "Удалить все данные?", text: "Тренировки и история на этом устройстве будут стёрты. Сначала можно сделать экспорт.", confirm: "Удалить всё", danger: true };
      render();
    }
  }

  function toggleCircuit(workoutId) {
    var w = findWorkout(workoutId);
    if (!w) return;
    w.circuit = w.circuit ? null : { rounds: 3, restSec: 30 };
    w.updatedAt = Date.now();
    persist();
    render();
  }

  function moveExercise(workoutId, exId, dir) {
    var w = findWorkout(workoutId);
    if (!w) return;
    var index = w.exercises.findIndex(function (ex) { return ex.id === exId; });
    var next = index + dir;
    if (index < 0 || next < 0 || next >= w.exercises.length) { render(); return; }
    var item = w.exercises.splice(index, 1)[0];
    w.exercises.splice(next, 0, item);
    w.updatedAt = Date.now();
    persist();
    render();
  }

  function bind() {
    document.addEventListener("click", function (event) {
      unlockAudio();
      var button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action === "close-overlay" && event.target !== button) return;
      handleAction(button.dataset.action, button);
    });
    document.addEventListener("submit", function (event) {
      var form = event.target.closest("[data-form='dialog']");
      if (!form) return;
      event.preventDefault();
      confirmDialog();
    });
    document.addEventListener("input", function (event) {
      var el = event.target;
      if (!(el instanceof HTMLInputElement) || !el.dataset.field) return;
      applyInput(el);
    });
    document.addEventListener("focusout", function (event) {
      var el = event.target;
      if (!(el instanceof HTMLInputElement) || !el.dataset.field) return;
      formatField(el);
    });
    document.addEventListener("change", function (event) {
      if (event.target.id !== "import-file") return;
      var file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 2000000) { toast("Файл слишком большой"); return; }
      file.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (err) { toast("Не удалось прочитать файл"); return; }
        if (!data || !Array.isArray(data.workouts) || !Array.isArray(data.sessions)) {
          toast("В файле нет тренировок");
          return;
        }
        ui.dialog = {
          intent: "import",
          title: "Импорт данных",
          text: "В файле " + data.workouts.length + " " + plural(data.workouts.length, "тренировка", "тренировки", "тренировок") + " и " + data.sessions.length + " " + plural(data.sessions.length, "запись", "записи", "записей") + ".",
          confirm: "Добавить",
          alt: "Заменить всё",
          payload: data
        };
        render();
      }).catch(function () { toast("Не удалось прочитать файл"); });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && (ui.dialog || ui.sheet)) {
        ui.dialog = null;
        ui.sheet = null;
        render();
      }
    });
    window.addEventListener("hashchange", function () {
      ui.sheet = null;
      ui.dialog = null;
      render({ scroll: 0 });
    });
    window.addEventListener("resize", layoutDocks);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        if (timer.phase === "run" && !timer.paused && timer.endsAt <= Date.now()) {
          if (Date.now() - timer.endsAt < 15 * 60 * 1000) completeTimer();
          else {
            stopTimer(true);
            toast("Таймер уже закончился");
            render();
          }
        } else paintTimer();
        lockWake();
      }
    });
  }

  bind();
  restoreTimer();
  render({ scroll: 0 });
  setInterval(function () {
    if (timer.phase !== "run" || timer.paused) return;
    if (timer.endsAt - Date.now() <= 0) completeTimer();
    else paintTimer();
  }, 200);

  if ("serviceWorker" in navigator && location.protocol !== "file:") warmSw();
})();
