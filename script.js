const STORAGE_KEY = "daypilot-ai-tasks-v1";
const PREFERENCES_KEY = "daypilot-ai-preferences-v1";
const SCHEDULE_KEY = "daypilot-ai-schedule-v1";
const PRIORITIES = ["high", "medium", "low"];
const SAMPLE_TASK_IDS = new Set(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7", "task-8"]);

const taskForm = document.querySelector("#task-form");
const taskInput = document.querySelector("#task-input");
const priorityInput = document.querySelector("#task-priority");
const durationInput = document.querySelector("#task-duration");
const deadlineInput = document.querySelector("#task-deadline");
const taskList = document.querySelector("#task-list");
const filterButtons = document.querySelectorAll(".filter-button");
const toast = document.querySelector("#toast");
const scheduleStartInput = document.querySelector("#schedule-start");
const scheduleEndInput = document.querySelector("#schedule-end");
const aiStatus = document.querySelector("#ai-status");
const aiStatusLabel = document.querySelector("#ai-status-label");

let toastTimer;
let scheduleRefreshTimer;
let scheduleRequestInProgress = false;
let scheduleRefreshQueued = false;
let activeFilter = "all";
let tasks = loadTasks();
let dailyPreferences = loadPreferences();
let generatedSchedule = loadGeneratedSchedule();
scheduleStartInput.value = dailyPreferences.start;
scheduleEndInput.value = dailyPreferences.end;

function getTodayKey() {
  const today = new Date();
  return [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY));
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(saved?.start) &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(saved?.end) &&
      parseTime(saved.end) > parseTime(saved.start)) {
      return { start: saved.start, end: saved.end };
    }
  } catch (error) {
    console.warn("Could not restore daily preferences.", error);
  }
  return { start: "09:00", end: "17:30" };
}

function loadGeneratedSchedule() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCHEDULE_KEY));
    if (
      saved?.date !== getTodayKey() ||
      !Array.isArray(saved.events) ||
      !Array.isArray(saved.orderedTasks) ||
      !Array.isArray(saved.unscheduled) ||
      !Number.isInteger(saved.dayStart) ||
      !Number.isInteger(saved.dayEnd) ||
      saved.dayEnd <= saved.dayStart
    ) return null;
    if (saved.events.some((event) => event.type === "task" && SAMPLE_TASK_IDS.has(event.task?.id))) {
      localStorage.removeItem(SCHEDULE_KEY);
      return null;
    }

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const events = saved.events.filter((event) => {
      if (!event || !["task", "break", "lunch"].includes(event.type) ||
        !Number.isInteger(event.start) || !Number.isInteger(event.end) || event.end <= event.start) return false;
      if (event.type !== "task") return true;
      const currentTask = taskById.get(event.task?.id);
      if (!currentTask) return false;
      event.task = { ...currentTask };
      event.title = currentTask.title;
      return true;
    });
    return { ...saved, events };
  } catch (error) {
    console.warn("Could not restore the generated schedule.", error);
    return null;
  }
}

function savePreferences() {
  dailyPreferences = { start: scheduleStartInput.value, end: scheduleEndInput.value };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(dailyPreferences));
  } catch (error) {
    console.warn("Could not save daily preferences.", error);
  }
}

function saveGeneratedSchedule(result, dayStart, dayEnd) {
  generatedSchedule = {
    ...result,
    dayStart,
    dayEnd,
    date: getTodayKey(),
    generatedAt: new Date().toISOString(),
    stale: false,
  };
  persistGeneratedSchedule();
}

function persistGeneratedSchedule() {
  if (!generatedSchedule) return;
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(generatedSchedule));
  } catch (error) {
    console.warn("Could not save the generated schedule.", error);
    showToast("Schedule created, but could not be saved in this browser.");
  }
}

function loadTasks() {
  try {
    const storedTasks = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(storedTasks)) {
      const realTasks = storedTasks.filter((task) => isValidTask(task) && !SAMPLE_TASK_IDS.has(task.id)).map(normalizeTask);
      if (realTasks.length !== storedTasks.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(realTasks));
      }
      return realTasks;
    }
  } catch (error) {
    console.warn("Could not load saved DayPilot tasks.", error);
  }
  return [];
}

function isValidTask(task) {
  return task && typeof task.id === "string" && typeof task.title === "string" &&
    task.title.trim() && PRIORITIES.includes(task.priority) &&
    Number.isFinite(Number(task.duration)) && Number(task.duration) > 0 &&
    typeof task.completed === "boolean" &&
    (task.deadline === undefined || task.deadline === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(task.deadline));
}

function normalizeTask(task) {
  return {
    id: task.id,
    title: task.title.trim(),
    priority: task.priority,
    duration: Number(task.duration),
    completed: task.completed,
    deadline: typeof task.deadline === "string" ? task.deadline : "",
  };
}

function saveTasks(scheduleChanged = true) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (error) {
    console.warn("Could not save DayPilot tasks.", error);
    showToast("Your changes could not be saved in this browser.");
  }
  refreshSavedSchedule(scheduleChanged);
  if (scheduleChanged && generatedSchedule) queueScheduleRefresh();
}

function queueScheduleRefresh() {
  window.clearTimeout(scheduleRefreshTimer);
  scheduleRefreshTimer = window.setTimeout(() => {
    if (scheduleRequestInProgress) {
      scheduleRefreshQueued = true;
      return;
    }
    generateDailySchedule();
  }, 700);
}

function refreshSavedSchedule(scheduleChanged) {
  if (!generatedSchedule) return;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  generatedSchedule.events = generatedSchedule.events.filter((event) => {
    if (event.type !== "task") return true;
    const currentTask = taskById.get(event.task.id);
    if (!currentTask) return false;
    event.task = { ...currentTask };
    event.title = currentTask.title;
    return true;
  });
  generatedSchedule.unscheduled = generatedSchedule.unscheduled.filter((task) => {
    const currentTask = taskById.get(task.id);
    return currentTask && !currentTask.completed;
  });
  generatedSchedule.orderedTasks = tasks.filter((task) => !task.completed).map((task) => ({ ...task }));
  if (scheduleChanged) generatedSchedule.stale = true;
  persistGeneratedSchedule();
  renderSchedule(generatedSchedule, generatedSchedule.dayStart, generatedSchedule.dayEnd);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createTaskRow(task) {
  const row = createElement("div", "task-item" + (task.completed ? " completed" : ""));
  row.dataset.id = task.id;
  row.dataset.status = task.completed ? "completed" : "pending";
  row.hidden = activeFilter !== "all" && activeFilter !== row.dataset.status;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.setAttribute("aria-label", "Mark " + task.title + " as " + (task.completed ? "pending" : "completed"));
  const customCheckbox = createElement("span", "custom-checkbox");
  customCheckbox.setAttribute("aria-hidden", "true");
  customCheckbox.innerHTML = '<svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7"/></svg>';

  const details = createElement("div", "task-details");
  const title = createElement("span", "task-text", task.title);
  const metadata = createElement("span", "task-metadata");
  const priority = createElement("span", "priority-label priority-" + task.priority, capitalize(task.priority) + " priority");
  const duration = createElement("span", "duration-label", formatDuration(task.duration));
  metadata.append(priority, duration);
  if (task.deadline) {
    metadata.append(createElement("span", "meta-divider", "·"));
    metadata.append(createElement("span", "deadline-label", "Due " + formatTime(parseTime(task.deadline))));
  }
  details.append(title, metadata);

  const actions = createElement("div", "task-actions");
  const editButton = createElement("button", "task-action edit-task", "Edit");
  editButton.type = "button";
  editButton.dataset.action = "edit";
  editButton.setAttribute("aria-label", "Edit " + task.title);
  const deleteButton = createElement("button", "task-action delete-task", "Delete");
  deleteButton.type = "button";
  deleteButton.dataset.action = "delete";
  deleteButton.setAttribute("aria-label", "Delete " + task.title);
  actions.append(editButton, deleteButton);

  row.append(checkbox, customCheckbox, details, actions);
  return row;
}

function renderTasks() {
  const fragment = document.createDocumentFragment();
  const visibleTasks = tasks.filter((task) => {
    return activeFilter === "all" || activeFilter === (task.completed ? "completed" : "pending");
  });
  if (visibleTasks.length === 0) {
    const message = tasks.length === 0
      ? "No tasks yet. Add the first thing you’d like to get done."
      : "No " + activeFilter + " tasks right now.";
    fragment.append(createElement("p", "task-empty", message));
  } else {
    visibleTasks.forEach((task) => fragment.append(createTaskRow(task)));
  }
  taskList.replaceChildren(fragment);
  updateTaskSummary();
}

function updateTaskSummary() {
  const completed = tasks.filter((task) => task.completed).length;
  const pending = tasks.length - completed;
  document.querySelector("#task-count").textContent = tasks.length;
  document.querySelector("#task-list-count").textContent = pending + " pending · " + completed + " completed";
  const counts = { all: tasks.length, pending, completed };
  filterButtons.forEach((button) => {
    button.querySelector("span").textContent = counts[button.dataset.filter];
  });
}

function setFilter(filter) {
  activeFilter = filter;
  filterButtons.forEach((button) => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderTasks();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDuration(minutes) {
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? hours + "h " + remainder + "m" : hours + "h";
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function parseTime(value) {
  const parts = value.split(":").map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;
}

function formatTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return String(displayHour).padStart(2, "0") + ":" + String(remainder).padStart(2, "0") + " " + period;
}

function createSchedule(tasksToSchedule, dayStart, dayEnd, lockedEvents = []) {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const orderedTasks = tasksToSchedule
    .map((task, index) => ({ ...task, originalOrder: index }))
    .sort((first, second) => priorityOrder[first.priority] - priorityOrder[second.priority] || first.originalOrder - second.originalOrder);
  const events = lockedEvents.map((event) => ({ ...event, task: { ...event.task, completed: true } }));
  const unscheduled = [];
  const lunchDuration = 45;
  const hasLunchWindow = tasksToSchedule.length > 0 && dayEnd - dayStart >= 240;
  const lunchStart = Math.min(Math.max(12 * 60 + 30, dayStart + 120), dayEnd - lunchDuration);
  let cursor = dayStart;
  let lunchAdded = false;
  let tasksSinceBreak = 0;

  function findFreeSlot(duration, earliest = cursor) {
    let candidate = earliest;
    let collision;
    do {
      collision = events
        .filter((event) => event.start < candidate + duration && event.end > candidate)
        .sort((first, second) => first.start - second.start)[0];
      if (collision) candidate = collision.end;
    } while (collision);
    return candidate;
  }

  function addLunch(earliest = Math.max(cursor, lunchStart)) {
    if (!hasLunchWindow || lunchAdded) return false;
    const start = findFreeSlot(lunchDuration, earliest);
    if (start + lunchDuration > dayEnd) return false;
    events.push({ type: "lunch", title: "Lunch break", start, end: start + lunchDuration });
    cursor = start + lunchDuration;
    lunchAdded = true;
    tasksSinceBreak = 0;
    return true;
  }

  function placeLunchBefore(durationIfScheduledNow) {
    if (!hasLunchWindow || lunchAdded) return;
    if (cursor >= lunchStart || (cursor < lunchStart && cursor + durationIfScheduledNow > lunchStart)) {
      addLunch(Math.max(cursor, lunchStart));
    }
  }

  for (const task of orderedTasks) {
    if (tasksSinceBreak >= 2) {
      placeLunchBefore(15);
      const breakStart = findFreeSlot(15);
      if (breakStart + 15 <= dayEnd) {
        events.push({ type: "break", title: "Short break", start: breakStart, end: breakStart + 15 });
        cursor = breakStart + 15;
      }
      tasksSinceBreak = 0;
    }

    placeLunchBefore(task.duration);
    const taskStart = findFreeSlot(task.duration);
    if (taskStart + task.duration > dayEnd || (task.deadline && taskStart + task.duration > parseTime(task.deadline))) {
      unscheduled.push(task);
      continue;
    }

    events.push({ type: "task", task: { ...task }, title: task.title, start: taskStart, end: taskStart + task.duration });
    cursor = taskStart + task.duration;
    tasksSinceBreak += 1;
  }

  if (hasLunchWindow && !lunchAdded) addLunch();
  events.sort((first, second) => first.start - second.start);
  return { events, unscheduled, orderedTasks, provider: "local" };
}

function renderSchedule(result, dayStart, dayEnd) {
  const timeline = document.querySelector("#timeline");
  const explanation = document.querySelector("#schedule-explanation");
  const fragment = document.createDocumentFragment();
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();

  if (!result.events.length) {
    const empty = createElement("p", "schedule-empty", "No pending tasks to schedule. Add or reopen a task to build your day.");
    timeline.replaceChildren(empty);
  } else {
    result.events.forEach((event, index) => {
      const row = createElement("div", "time-row generated-row");
      row.dataset.eventIndex = index;
      const time = createElement("div", "time-label", formatTime(event.start));
      const slot = createElement("div", "time-slot");
      const isCompleted = event.type === "task" && event.task.completed;
      const isCurrent = !isCompleted && event.start <= currentMinute && currentMinute < event.end;
      const state = isCompleted ? "completed" : isCurrent ? "in-progress" : event.end <= currentMinute ? "pending" : "upcoming";
      row.dataset.scheduleState = state;
      row.classList.toggle("current-row", isCurrent);
      const dot = createElement("span", "timeline-dot " + (isCurrent ? "current-dot" : isCompleted ? "done-dot" : event.type === "task" ? "generated-dot" : "break-dot"));
      const card = createElement("article", "event-card generated-event " + event.type + "-event");
      card.classList.toggle("current-event", isCurrent);
      const top = createElement("div", "event-top");
      const category = createElement("span", "event-category");
      const categoryDot = createElement("i", "category-dot " + event.type + "-category-dot");
      const categoryLabel = event.type === "task" ? capitalize(event.task.priority) + " priority" : event.type === "lunch" ? "Long break" : "Reset";
      category.append(categoryDot, document.createTextNode(categoryLabel));
      if (isCurrent) category.append(createElement("span", "now-pill", "NOW"));
      const duration = createElement("span", "event-duration", formatDuration(event.end - event.start));
      top.append(category, duration);
      const title = createElement("h3", "", event.title);
      const meta = createElement("div", "event-meta");
      const stateLabel = state === "completed" ? "Completed" : state === "in-progress" ? "In progress" : state === "pending" ? "Pending" : "Upcoming";
      if (event.type === "task") {
        meta.append(
          createElement("span", "schedule-state " + state, stateLabel),
          createElement("span", "meta-divider", "·"),
          createElement("span", "duration-label", formatDuration(event.end - event.start)),
        );
      } else {
        meta.textContent = state === "in-progress" ? "In progress · " : stateLabel + " · ";
        meta.append(document.createTextNode(event.type === "lunch" ? "45 minutes to recharge" : "15 minutes between task groups"));
      }
      card.append(top, title, meta);
      slot.append(dot, card);
      row.append(time, slot);
      fragment.append(row);
    });
    timeline.replaceChildren(fragment);
  }

  const scheduledCount = result.events.filter((event) => event.type === "task" && !event.task.completed).length;
  const breakCount = result.events.filter((event) => event.type === "break").length;
  const summary = createElement("p", "explanation-summary");
  summary.textContent = "Scheduled " + scheduledCount + " of " + result.orderedTasks.length +
    " pending tasks from " + formatTime(dayStart) + " to " + formatTime(dayEnd) +
    ", with high priority tasks first" + (breakCount ? " and " + breakCount + " short " + (breakCount === 1 ? "break" : "breaks") : "") +
    (result.events.some((event) => event.type === "lunch") ? " plus a 45-minute lunch." : ".");
  const scheduleTitle = result.provider === "gemini"
    ? "Gemini AI Schedule"
    : result.fallbackReason
      ? "Local Schedule (Fallback)"
      : "Today’s schedule";
  explanation.replaceChildren(createElement("h3", "", scheduleTitle));
  if (result.fallbackReason) {
    explanation.append(createElement("p", "model-explanation", "Gemini unavailable: " + result.fallbackReason));
  }
  if (result.explanation) {
    explanation.append(createElement("p", "model-explanation", result.explanation));
  }
  explanation.append(summary);

  if (result.unscheduled.length) {
    const overflow = createElement("div", "unscheduled-note");
    const heading = createElement("strong", "", result.unscheduled.length + " task" + (result.unscheduled.length === 1 ? "" : "s") + " didn't fit");
    const list = createElement("ul", "");
    result.unscheduled.forEach((task) => {
      const item = createElement("li", "", task.title + " · " + formatDuration(task.duration) + " · " + task.priority + " priority");
      list.append(item);
    });
    overflow.append(heading, list);
    explanation.append(overflow);
  } else if (result.orderedTasks.length) {
    explanation.append(createElement("p", "explanation-overflow", "All pending tasks fit in your available hours."));
  }
  if (result.stale) {
    explanation.append(createElement("p", "schedule-stale-note", "Tasks or daily hours changed since this timetable was generated. Regenerate to refresh it."));
  }
  explanation.hidden = false;
}

function getEventState(event, now) {
  if (event.type === "task" && event.task.completed) return "completed";
  if (event.start <= now && now < event.end) return "in-progress";
  return event.end <= now ? "pending" : "upcoming";
}

function updateCurrentScheduleHighlight() {
  if (!generatedSchedule) return;
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  document.querySelectorAll(".generated-row").forEach((row) => {
    const event = generatedSchedule.events[Number(row.dataset.eventIndex)];
    if (!event) return;
    const state = getEventState(event, currentMinute);
    const isCurrent = state === "in-progress";
    row.dataset.scheduleState = state;
    row.classList.toggle("current-row", isCurrent);
    const card = row.querySelector(".generated-event");
    const dot = row.querySelector(".timeline-dot");
    card.classList.toggle("current-event", isCurrent);
    dot.classList.toggle("current-dot", isCurrent);
    dot.classList.toggle("done-dot", state === "completed");
    const category = row.querySelector(".event-category");
    const nowPill = category.querySelector(".now-pill");
    if (isCurrent && !nowPill) category.append(createElement("span", "now-pill", "NOW"));
    if (!isCurrent && nowPill) nowPill.remove();
    const stateLabel = state === "completed" ? "Completed" : isCurrent ? "In progress" : state === "pending" ? "Pending" : "Upcoming";
    const stateElement = row.querySelector(".schedule-state");
    if (stateElement) {
      stateElement.textContent = stateLabel;
      stateElement.className = "schedule-state " + state;
    } else {
      const meta = row.querySelector(".event-meta");
      const description = event.type === "lunch" ? "45 minutes to recharge" : "15 minutes between task groups";
      meta.textContent = stateLabel + " · " + description;
    }
  });
}

function setScheduleLoading(isLoading) {
  const button = document.querySelector("#auto-schedule");
  const label = button.querySelector(".schedule-button-label");
  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  label.textContent = isLoading ? "Building your schedule…" : "Auto-Schedule My Day";
  button.setAttribute("aria-busy", String(isLoading));
  if (isLoading) setAiStatus("loading", "Planning");
}

function setAiStatus(mode, label) {
  aiStatus.dataset.mode = mode;
  aiStatusLabel.textContent = label;
}

function getLockedCompletedEvents(dayStart, dayEnd) {
  if (!generatedSchedule) return [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return generatedSchedule.events
    .filter((event) => {
      if (event.type !== "task") return false;
      const task = taskById.get(event.task.id);
      return task?.completed && event.start >= dayStart && event.end <= dayEnd;
    })
    .map((event) => ({
      ...event,
      task: { ...event.task, completed: true },
      fixed: true,
    }));
}

function mergeLockedEvents(schedule, lockedEvents) {
  return {
    ...schedule,
    events: [...lockedEvents, ...schedule.events].sort((first, second) => first.start - second.start),
  };
}

function isValidBackendSchedule(data, pendingTasks, dayStart, dayEnd, lockedEvents = []) {
  if (
    !data ||
    !Array.isArray(data.events) ||
    !Array.isArray(data.unscheduled) ||
    typeof data.explanation !== "string"
  ) {
    throw new Error("The backend response is incomplete.");
  }

  const taskById = new Map(pendingTasks.map((task) => [task.id, task]));
  const accountedIds = new Set();
  let lunchCount = 0;
  const events = data.events.map((event) => {
    if (
      !event ||
      !["task", "break", "lunch"].includes(event.type) ||
      !Number.isInteger(event.start) ||
      !Number.isInteger(event.end) ||
      event.start < dayStart ||
      event.end > dayEnd ||
      event.end <= event.start
    ) {
      throw new Error("The backend returned invalid event times.");
    }

    if (event.type === "task") {
      const taskId = event.task?.id;
      const task = taskById.get(taskId);
      if (
        !task ||
        accountedIds.has(taskId) ||
        event.start + task.duration !== event.end ||
        event.task.title !== task.title ||
        event.task.priority !== task.priority ||
        event.task.duration !== task.duration
      ) {
        throw new Error("The backend returned invalid task details.");
      }
      accountedIds.add(taskId);
      return { type: "task", task, title: task.title, start: event.start, end: event.end };
    }

    const expectedDuration = event.type === "break" ? 15 : 45;
    if (event.end - event.start !== expectedDuration) {
      throw new Error("The backend returned an invalid break duration.");
    }
    if (event.type === "lunch") lunchCount += 1;
    if (lunchCount > 1) throw new Error("The backend returned multiple lunch breaks.");
    return { type: event.type, title: event.title, start: event.start, end: event.end };
  });

  data.unscheduled.forEach((item) => {
    const taskId = typeof item === "string" ? item : item?.id;
    const task = taskById.get(taskId);
    if (!task || accountedIds.has(taskId)) {
      throw new Error("The backend returned invalid unscheduled tasks.");
    }
    accountedIds.add(taskId);
  });
  if (accountedIds.size !== pendingTasks.length) {
    throw new Error("The backend did not account for every pending task.");
  }

  events.sort((first, second) => first.start - second.start);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].start < events[index - 1].end) {
      throw new Error("The backend returned overlapping events.");
    }
  }
  events.forEach((event) => {
    if (lockedEvents.some((locked) => event.start < locked.end && event.end > locked.start)) {
      throw new Error("The backend moved a task into a completed slot.");
    }
  });

  events.forEach((event) => {
    if (event.type === "task" && event.task.deadline && event.end > parseTime(event.task.deadline)) {
      throw new Error("A task was scheduled after its deadline.");
    }
  });

  const taskOrder = [...pendingTasks].sort((first, second) => rank[first.priority] - rank[second.priority]);
  const unscheduledIds = new Set(data.unscheduled.map((item) => typeof item === "string" ? item : item.id));
  return {
    events,
    orderedTasks: taskOrder,
    unscheduled: taskOrder.filter((task) => unscheduledIds.has(task.id)),
    explanation: data.explanation.trim().slice(0, 500),
    provider: "gemini",
  };
}

async function requestGeminiSchedule(start, end, lockedEvents) {
  let response;
  try {
    response = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(125000),
      body: JSON.stringify({
        goal: "Plan my day and schedule my pending tasks, respecting their priorities and any deadlines.",
        tasks: tasks.map(({ id, title, priority, duration, completed, deadline }) => ({ id, title, priority, duration, completed, deadline })),
        preferences: {
          start: String(Math.floor(start / 60)).padStart(2, "0") + ":" + String(start % 60).padStart(2, "0"),
          end: String(Math.floor(end / 60)).padStart(2, "0") + ":" + String(end % 60).padStart(2, "0"),
          busySlots: lockedEvents.map((event) => ({
            taskId: event.task.id,
            start: event.start,
            end: event.end,
          })),
        },
      }),
    });
  } catch (error) {
    const requestError = new Error(error.name === "TimeoutError"
      ? "The scheduling agent did not finish within its time limit. Check the backend terminal for a Gemini 504 or timeout detail."
      : "The scheduling backend is unreachable. Start it with npm start in the backend folder, then open DayPilot at http://localhost:3000.");
    requestError.code = error.name === "TimeoutError" ? "BACKEND_TIMEOUT" : "BACKEND_UNAVAILABLE";
    throw requestError;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    error.code = "INVALID_BACKEND_RESPONSE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || "The scheduling service returned an error.");
    error.code = data.code || "GEMINI_UNAVAILABLE";
    throw error;
  }
  if (Array.isArray(data.taskUpdates)) {
    const updates = new Map(data.taskUpdates.map((item) => [item.id, item.completed]));
    let changed = false;
    tasks.forEach((task) => {
      if (updates.has(task.id) && typeof updates.get(task.id) === "boolean" && task.completed !== updates.get(task.id)) {
        task.completed = updates.get(task.id);
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      renderTasks();
    }
  }
  try {
    return isValidBackendSchedule(data, tasks.filter((task) => !task.completed), start, end, lockedEvents);
  } catch (error) {
    error.code = error.code || "INVALID_BACKEND_RESPONSE";
    throw error;
  }
}

async function generateDailySchedule() {
  if (scheduleRequestInProgress) {
    scheduleRefreshQueued = true;
    return;
  }
  const start = parseTime(scheduleStartInput.value);
  const end = parseTime(scheduleEndInput.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    showToast("Choose an end time later than your start time.");
    return;
  }

  savePreferences();
  const pendingTasks = tasks.filter((task) => !task.completed);
  const lockedEvents = getLockedCompletedEvents(start, end);
  if (pendingTasks.length === 0) {
    const completedOnlySchedule = createSchedule(pendingTasks, start, end, lockedEvents);
    renderSchedule(completedOnlySchedule, start, end);
    saveGeneratedSchedule(completedOnlySchedule, start, end);
    setAiStatus("ready", "Ready");
    showToast("No pending tasks to schedule.");
    return;
  }

  setScheduleLoading(true);
  scheduleRequestInProgress = true;
  try {
    const geminiSchedule = await requestGeminiSchedule(start, end, lockedEvents);
    const result = mergeLockedEvents(geminiSchedule, lockedEvents);
    renderSchedule(result, start, end);
    saveGeneratedSchedule(result, start, end);
    setAiStatus("gemini", "Gemini");
    showToast(result.unscheduled.length
      ? "Gemini mode: " + result.unscheduled.length + " task" + (result.unscheduled.length === 1 ? " needs" : "s need") + " more time."
      : "Gemini mode: schedule regenerated. Completed slots stayed in place.");
  } catch (error) {
    console.warn("Using the local schedule fallback:", error.code || "UNKNOWN_ERROR", error.message);
    const fallback = createSchedule(pendingTasks, start, end, lockedEvents);
    fallback.fallbackReason = error.message || "Gemini returned an unexpected error.";
    renderSchedule(fallback, start, end);
    saveGeneratedSchedule(fallback, start, end);
    setAiStatus("fallback", "Local fallback");
    showToast("Local fallback: " + fallback.fallbackReason);
  } finally {
    scheduleRequestInProgress = false;
    setScheduleLoading(false);
    document.querySelector("#schedule").scrollIntoView({ behavior: "smooth", block: "start" });
    if (scheduleRefreshQueued) {
      scheduleRefreshQueued = false;
      queueScheduleRefresh();
    }
  }
}

function createId() {
  return window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : "task-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function handleAddTask(event) {
  event.preventDefault();
  const title = taskInput.value.trim();
  const duration = Number(durationInput.value);
  if (!title) return taskInput.focus();
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) {
    durationInput.setCustomValidity("Enter a duration from 5 to 1,440 minutes.");
    durationInput.reportValidity();
    durationInput.setCustomValidity("");
    return durationInput.focus();
  }
  tasks.unshift({ id: createId(), title, priority: priorityInput.value, duration, deadline: deadlineInput.value, completed: false });
  taskForm.reset();
  durationInput.value = "30";
  deadlineInput.value = "";
  setFilter("all");
  saveTasks();
  taskInput.focus();
}

function createEditForm(task) {
  const form = createElement("form", "task-edit-form");
  form.dataset.id = task.id;
  const title = document.createElement("input");
  title.name = "title";
  title.value = task.title;
  title.maxLength = 120;
  title.required = true;
  title.setAttribute("aria-label", "Task title");
  const priority = document.createElement("select");
  priority.name = "priority";
  priority.setAttribute("aria-label", "Priority");
  PRIORITIES.forEach((value) => {
    const option = createElement("option", "", capitalize(value) + " priority");
    option.value = value;
    option.selected = value === task.priority;
    priority.append(option);
  });
  const duration = document.createElement("input");
  duration.name = "duration";
  duration.type = "number";
  duration.min = "5";
  duration.max = "1440";
  duration.step = "5";
  duration.value = task.duration;
  duration.required = true;
  duration.setAttribute("aria-label", "Estimated duration in minutes");
  const deadline = document.createElement("input");
  deadline.name = "deadline";
  deadline.type = "time";
  deadline.value = task.deadline || "";
  deadline.setAttribute("aria-label", "Deadline (optional)");
  const saveButton = createElement("button", "edit-save", "Save");
  saveButton.type = "submit";
  const cancelButton = createElement("button", "edit-cancel", "Cancel");
  cancelButton.type = "button";
  cancelButton.dataset.action = "cancel-edit";
  form.append(title, priority, duration, deadline, saveButton, cancelButton);
  return form;
}

function startEditing(task) {
  const row = [...taskList.querySelectorAll(".task-item")].find((item) => item.dataset.id === task.id);
  if (!row) return;
  row.replaceChildren(createEditForm(task));
  row.classList.add("editing");
  row.querySelector('input[name="title"]').focus();
  row.querySelector('input[name="title"]').select();
}

function handleEditSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.matches(".task-edit-form")) return;
  const formData = new FormData(form);
  const title = String(formData.get("title") || "").trim();
  const duration = Number(formData.get("duration"));
  const priority = String(formData.get("priority"));
  const deadline = String(formData.get("deadline") || "");
  if (!title || !PRIORITIES.includes(priority) || !Number.isInteger(duration) || duration < 5 || duration > 1440) {
    form.reportValidity();
    return;
  }
  const task = tasks.find((item) => item.id === form.dataset.id);
  if (!task) return;
  Object.assign(task, { title, priority, duration, deadline });
  saveTasks();
  renderTasks();
}

function handleTaskClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest(".task-item");
  const task = tasks.find((item) => item.id === row?.dataset.id);
  if (!task) return;
  if (button.dataset.action === "edit") return startEditing(task);
  if (button.dataset.action === "delete") {
    tasks = tasks.filter((item) => item.id !== task.id);
    saveTasks();
    renderTasks();
    return showToast("Task deleted.");
  }
  if (button.dataset.action === "cancel-edit") renderTasks();
}

function handleTaskChange(event) {
  if (!event.target.matches(".task-checkbox")) return;
  const row = event.target.closest(".task-item");
  const task = tasks.find((item) => item.id === row.dataset.id);
  if (!task) return;
  task.completed = event.target.checked;
  saveTasks();
  renderTasks();
}

function handleSchedulePreferenceChange() {
  const start = parseTime(scheduleStartInput.value);
  const end = parseTime(scheduleEndInput.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    showToast("Choose an end time later than your start time.");
    return;
  }
  savePreferences();
  if (generatedSchedule && (start !== generatedSchedule.dayStart || end !== generatedSchedule.dayEnd)) {
    generatedSchedule.stale = true;
    persistGeneratedSchedule();
    renderSchedule(generatedSchedule, generatedSchedule.dayStart, generatedSchedule.dayEnd);
    queueScheduleRefresh();
  }
}

taskForm.addEventListener("submit", handleAddTask);
durationInput.addEventListener("input", () => durationInput.setCustomValidity(""));
taskList.addEventListener("click", handleTaskClick);
taskList.addEventListener("change", handleTaskChange);
taskList.addEventListener("submit", handleEditSubmit);
filterButtons.forEach((button) => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});
scheduleStartInput.addEventListener("change", handleSchedulePreferenceChange);
scheduleEndInput.addEventListener("change", handleSchedulePreferenceChange);

document.querySelector("#auto-schedule").addEventListener("click", generateDailySchedule);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    toast.classList.remove("visible");
  }
});

renderTasks();
if (generatedSchedule) {
  renderSchedule(generatedSchedule, generatedSchedule.dayStart, generatedSchedule.dayEnd);
  updateCurrentScheduleHighlight();
  setAiStatus(generatedSchedule.provider === "gemini" ? "gemini" : "fallback",
    generatedSchedule.provider === "gemini" ? "Gemini AI" : "Local fallback");
}
window.setInterval(updateCurrentScheduleHighlight, 30_000);
