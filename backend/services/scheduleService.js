import { GoogleGenAI } from "@google/genai";
import { createAgentToolbox } from "./agentTools.js";

const priorities = ["high", "medium", "low"];
const priorityRank = { high: 0, medium: 1, low: 2 };
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class ScheduleError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ScheduleError";
    this.status = status;
    this.code = code;
  }
}

export function validateScheduleRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ScheduleError("A JSON request body is required.", 400, "INVALID_REQUEST");
  }

  const { tasks, preferences } = body;
  if (!Array.isArray(tasks) || tasks.length > 100) {
    throw new ScheduleError("Provide up to 100 tasks.", 400, "INVALID_TASKS");
  }

  const normalizedTasks = tasks.map((task) => {
    if (
      !task ||
      typeof task.id !== "string" ||
      task.id.length > 100 ||
      typeof task.title !== "string" ||
      !task.title.trim() ||
      task.title.length > 200 ||
      !priorities.includes(task.priority) ||
      !Number.isInteger(task.duration) ||
      task.duration < 5 ||
      task.duration > 1440 ||
      (task.completed !== undefined && typeof task.completed !== "boolean") ||
      (task.deadline !== undefined && task.deadline !== "" && !timePattern.test(task.deadline))
    ) {
      throw new ScheduleError(
        "Each task needs an id, title, valid priority, and duration from 5 to 1,440 minutes.",
        400,
        "INVALID_TASK",
      );
    }

    return {
      id: task.id,
      title: task.title.trim(),
      priority: task.priority,
      duration: task.duration,
      completed: task.completed === true,
      ...(task.deadline ? { deadline: task.deadline } : {}),
    };
  });

  if (
    !preferences ||
    !timePattern.test(preferences.start) ||
    !timePattern.test(preferences.end) ||
    toMinutes(preferences.end) <= toMinutes(preferences.start)
  ) {
    throw new ScheduleError(
      "Choose valid daily start and end times, with the end after the start.",
      400,
      "INVALID_PREFERENCES",
    );
  }

  const busySlots = preferences.busySlots === undefined ? [] : preferences.busySlots;
  if (!Array.isArray(busySlots) || busySlots.length > 100) {
    throw new ScheduleError("Completed schedule slots are invalid.", 400, "INVALID_BUSY_SLOTS");
  }
  const normalizedBusySlots = busySlots.map((slot) => {
    if (
      !slot ||
      typeof slot.taskId !== "string" ||
      !Number.isInteger(slot.start) ||
      !Number.isInteger(slot.end) ||
      slot.start < toMinutes(preferences.start) ||
      slot.end > toMinutes(preferences.end) ||
      slot.end <= slot.start
    ) {
      throw new ScheduleError("Completed schedule slots must fit inside the selected day.", 400, "INVALID_BUSY_SLOTS");
    }
    return { taskId: slot.taskId, start: slot.start, end: slot.end };
  });
  const sortedBusySlots = [...normalizedBusySlots].sort((first, second) => first.start - second.start);
  for (let index = 1; index < sortedBusySlots.length; index += 1) {
    if (sortedBusySlots[index].start < sortedBusySlots[index - 1].end) {
      throw new ScheduleError("Completed schedule slots cannot overlap.", 400, "INVALID_BUSY_SLOTS");
    }
  }

  return {
    tasks: normalizedTasks,
    preferences: {
      start: preferences.start,
      end: preferences.end,
      startMinutes: toMinutes(preferences.start),
      endMinutes: toMinutes(preferences.end),
      busySlots: normalizedBusySlots,
    },
  };
}

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function createPrompt(scheduleRequest, goal) {
  const pendingTasks = scheduleRequest.tasks.filter((task) => !task.completed);
  const { preferences } = scheduleRequest;
  return [
    "You are DayPilot, a personal planning agent. Fulfill this goal: " + goal,
    "Use the supplied tasks and availability directly; do not spend extra turns reading them unless needed. Decide whether create_schedule or reschedule_pending_tasks applies, then call it with a complete plan. If validation reports a problem, correct the plan. After a plan validates, call save_final_schedule.",
    "Reason about priority, duration, and deadlines together. Schedule higher-priority tasks early when deadlines allow. Never schedule a task past its deadline. List every pending task exactly once, as a task event or unscheduled ID.",
    "Use exact task IDs, titles, priorities, and durations. Use integer minutes after midnight. Never overlap events or the completed fixed slots. Order events chronologically.",
    "Add a 15-minute break between suitable task groups and one 45-minute lunch break when capacity allows. Breaks use an empty taskId, low priority, and the titles Short break or Lunch break.",
    "Keep the explanation short and factual. Do not change task statuses unless the user's goal explicitly asks for it.",
    "Goal: " + goal,
    "Daily availability: " + JSON.stringify({ start: preferences.start, end: preferences.end, fixedCompletedSlots: preferences.busySlots }),
    "Pending tasks: " + JSON.stringify(pendingTasks),
  ].join("\n");
}

export function validateGeminiSchedule(rawResult, scheduleRequest) {
  const { tasks, preferences } = scheduleRequest;
  if (
    !rawResult ||
    !Array.isArray(rawResult.events) ||
    !Array.isArray(rawResult.unscheduledTaskIds) ||
    typeof rawResult.explanation !== "string" ||
    !rawResult.explanation.trim()
  ) {
    throw new ScheduleError("Gemini returned an incomplete schedule.", 502, "INVALID_GEMINI_RESPONSE");
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const accountedTaskIds = new Set();
  const events = rawResult.events.map((event) => {
    if (
      !event ||
      !["task", "break", "lunch"].includes(event.type) ||
      typeof event.title !== "string" ||
      !Number.isInteger(event.startMinute) ||
      !Number.isInteger(event.endMinute) ||
      !Number.isInteger(event.durationMinutes) ||
      event.startMinute < preferences.startMinutes ||
      event.endMinute > preferences.endMinutes ||
      event.endMinute <= event.startMinute ||
      event.endMinute - event.startMinute !== event.durationMinutes
    ) {
      throw new ScheduleError("Gemini returned invalid event times.", 502, "INVALID_GEMINI_RESPONSE");
    }

    if (event.type === "task") {
      const task = taskById.get(event.taskId);
      if (
        !task ||
        accountedTaskIds.has(task.id) ||
        event.title !== task.title ||
        event.priority !== task.priority ||
        event.durationMinutes !== task.duration
      ) {
        throw new ScheduleError("Gemini returned task data that does not match the request.", 502, "INVALID_GEMINI_RESPONSE");
      }
      accountedTaskIds.add(task.id);
      return {
        type: "task",
        task: { ...task },
        title: task.title,
        start: event.startMinute,
        end: event.endMinute,
      };
    }

    const expectedDuration = event.type === "break" ? 15 : 45;
    if (event.durationMinutes !== expectedDuration) {
      throw new ScheduleError("Gemini returned an invalid break duration.", 502, "INVALID_GEMINI_RESPONSE");
    }
    return {
      type: event.type,
      title: event.type === "lunch" ? "Lunch break" : "Short break",
      start: event.startMinute,
      end: event.endMinute,
    };
  });

  const unscheduled = rawResult.unscheduledTaskIds.map((taskId) => {
    const task = taskById.get(taskId);
    if (!task || accountedTaskIds.has(taskId)) {
      throw new ScheduleError("Gemini returned invalid unscheduled tasks.", 502, "INVALID_GEMINI_RESPONSE");
    }
    accountedTaskIds.add(taskId);
    return { ...task };
  });

  if (accountedTaskIds.size !== tasks.length) {
    throw new ScheduleError("Gemini did not account for every pending task.", 502, "INVALID_GEMINI_RESPONSE");
  }

  const chronologicalEvents = [...events].sort((first, second) => first.start - second.start);
  for (let index = 1; index < chronologicalEvents.length; index += 1) {
    if (chronologicalEvents[index].start < chronologicalEvents[index - 1].end) {
      throw new ScheduleError("Gemini returned overlapping events.", 502, "INVALID_GEMINI_RESPONSE");
    }
  }
  for (const event of chronologicalEvents) {
    if (preferences.busySlots.some((slot) => event.start < slot.end && event.end > slot.start)) {
      throw new ScheduleError("Gemini overlapped a completed task.", 502, "INVALID_GEMINI_RESPONSE");
    }
  }

  chronologicalEvents.forEach((event) => {
    if (event.type === "task" && event.task.deadline && event.end > toMinutes(event.task.deadline)) {
      throw new ScheduleError("Task \"" + event.task.title + "\" was scheduled after its deadline.", 502, "INVALID_GEMINI_RESPONSE");
    }
  });

  return {
    events: chronologicalEvents,
    unscheduled,
    orderedTasks: [...tasks].sort((first, second) => priorityRank[first.priority] - priorityRank[second.priority]),
    explanation: rawResult.explanation.trim().slice(0, 500),
    provider: "gemini",
  };
}

export async function generateGeminiSchedule(scheduleRequest, goal = "Plan my day and schedule my pending tasks.") {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ScheduleError(
      "Gemini API key is not configured. Set GEMINI_API_KEY in backend/.env.",
      503,
      "GEMINI_NOT_CONFIGURED",
    );
  }

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const agentContext = { ...scheduleRequest, goal };
  const toolbox = createAgentToolbox(agentContext, validateGeminiSchedule);
  const history = [{ role: "user", parts: [{ text: createPrompt(scheduleRequest, goal) }] }];
  const maxTurns = 4;
  const maxToolCalls = 10;
  const executionDeadline = Date.now() + 115000;
  let toolCallCount = 0;
  let response;
  try {
    const ai = new GoogleGenAI({ apiKey });
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (Date.now() >= executionDeadline) {
        throw new ScheduleError("The planning agent reached its time limit before finishing.", 502, "AGENT_TIMEOUT");
      }
      response = await ai.models.generateContent({
        model,
        contents: history,
        config: {
          tools: [{ functionDeclarations: toolbox.declarations }],
          httpOptions: {
            timeout: 45000,
            retryOptions: {
              attempts: 2,
              initialDelay: 0.5,
              maxDelay: 2,
              httpStatusCodes: [408, 429, 500, 502, 503, 504],
            },
          },
          abortSignal: AbortSignal.timeout(Math.max(1, Math.min(45000, executionDeadline - Date.now()))),
          ...(model.startsWith("gemini-3.") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      });
      const calls = response.functionCalls || [];
      if (!calls.length) break;
      const modelContent = response.candidates?.[0]?.content;
      if (!modelContent) throw new Error("Gemini returned tool calls without a conversation turn.");
      history.push(modelContent);
      const functionResponses = [];
      for (const call of calls) {
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) {
          throw new ScheduleError("The planning agent reached its action limit before finishing.", 502, "AGENT_ACTION_LIMIT");
        }
        const result = toolbox.execute(call.name, call.args || {});
        functionResponses.push({
          functionResponse: { id: call.id, name: call.name, response: result },
        });
      }
      history.push({ role: "user", parts: functionResponses });
    }
  } catch (error) {
    if (error instanceof ScheduleError) throw error;
    const status = Number(error?.status || error?.statusCode || error?.code) || 0;
    const cause = error?.cause;
    const rawMessage = [error?.message, cause?.message, cause?.code].filter(Boolean).join(" | ") || String(error || "Unknown Gemini error");
    const safeMessage = rawMessage.split(apiKey).join("[REDACTED]").replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
    let code = "GEMINI_UNAVAILABLE";
    let message = "Gemini could not generate a schedule. Check the backend connection and try again.";

    if (status === 404 || /model.*(not found|invalid|unsupported)|model[s]?\//i.test(rawMessage)) {
      code = "GEMINI_MODEL_INVALID";
      message = "Gemini model \"" + model + "\" was rejected. Check GEMINI_MODEL in backend/.env.";
    } else if (status === 401 || status === 403 || /api.?key|unauthori[sz]ed|permission denied/i.test(rawMessage)) {
      code = "GEMINI_AUTH_FAILED";
      message = "Gemini rejected the configured API key or its permissions. Check GEMINI_API_KEY in backend/.env.";
    } else if (status === 429 || /quota|rate.?limit|resource exhausted/i.test(rawMessage)) {
      code = "GEMINI_QUOTA_EXCEEDED";
      message = "Gemini quota or rate limit was reached. Try again later.";
    } else if (status === 504 || /deadline[_ ]exceeded|timeout|timed out|abort/i.test(rawMessage)) {
      code = "GEMINI_TIMEOUT";
      message = "Gemini exceeded its response deadline (504). This is a response-time issue, not a missing-key error. Try again; DayPilot will use the local scheduler if it persists.";
    } else if (status) {
      code = status === 400 ? "GEMINI_REQUEST_REJECTED" : code;
      message = status === 400
        ? "Gemini rejected the schedule request (HTTP 400). Check the backend log for details."
        : "Gemini returned HTTP " + status + ". Check the backend log for details.";
    } else if (cause?.code) {
      message = "Gemini API connection failed (" + String(cause.code).replace(/[^A-Z0-9_]/gi, "") + "). Check backend network access and try again.";
    }

    console.error("Gemini schedule request failed", JSON.stringify({
      model,
      status: status || undefined,
      errorName: error?.name || "Error",
      causeCode: cause?.code || undefined,
      causeName: cause?.name || undefined,
      code,
      detail: safeMessage.slice(0, 1200),
    }));
    throw new ScheduleError(message, 502, code);
  }

  const finalSchedule = toolbox.getFinalSchedule();
  if (!finalSchedule) {
    const detail = typeof response?.text === "string" ? response.text.trim().slice(0, 240) : "No final schedule was saved by the agent.";
    console.warn("Gemini agent ended without a saved, validated schedule", JSON.stringify({ toolCallCount, detail }));
    throw new ScheduleError("Gemini did not complete and save a validated schedule. Try again or use the local fallback.", 502, "AGENT_INCOMPLETE");
  }
  return {
    ...finalSchedule,
    explanation: finalSchedule.explanation + " Agent actions: " + toolbox.actions.join(", ") + ".",
    taskUpdates: toolbox.getTaskUpdates(),
    agentActions: toolbox.actions,
  };
}
