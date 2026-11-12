const scheduleParameters = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["task", "break", "lunch"] },
          taskId: { type: "string" },
          title: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          durationMinutes: { type: "integer" },
          startMinute: { type: "integer" },
          endMinute: { type: "integer" },
        },
        required: ["type", "taskId", "title", "priority", "durationMinutes", "startMinute", "endMinute"],
      },
    },
    unscheduledTaskIds: { type: "array", items: { type: "string" } },
    explanation: { type: "string" },
  },
  required: ["events", "unscheduledTaskIds", "explanation"],
};

export const agentFunctionDeclarations = [
  {
    name: "read_pending_tasks",
    description: "Read the current pending tasks with priority, estimated duration, and optional deadline.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "read_daily_availability",
    description: "Read the selected daily start/end times and completed task slots that must remain fixed.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "create_schedule",
    description: "Propose a complete schedule. The application validates every task, deadline, time, and conflict before accepting it.",
    parametersJsonSchema: scheduleParameters,
  },
  {
    name: "reschedule_pending_tasks",
    description: "Propose a replacement schedule for only the tasks that are still pending, preserving completed fixed slots.",
    parametersJsonSchema: scheduleParameters,
  },
  {
    name: "update_task_status",
    description: "Update a task's status only when the user's goal explicitly asks to complete or reopen that task.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        completed: { type: "boolean" },
      },
      required: ["taskId", "completed"],
    },
  },
  {
    name: "save_final_schedule",
    description: "Save the validated schedule as the final result. Call only after create_schedule or reschedule_pending_tasks succeeds.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
];

export function createAgentToolbox(context, validateSchedule) {
  let draftSchedule = null;
  let finalSchedule = null;
  const actions = [];

  function getPendingTasks() {
    return context.tasks.filter((task) => !task.completed);
  }

  function createSchedule(args, actionName) {
    finalSchedule = null;
    try {
      const schedule = validateSchedule(args, { ...context, tasks: getPendingTasks() });
      draftSchedule = schedule;
      actions.push(actionName);
      return { ok: true, scheduled: schedule.events.filter((event) => event.type === "task").length,
        unscheduled: schedule.unscheduled.map((task) => task.id), validation: "passed" };
    } catch (error) {
      draftSchedule = null;
      actions.push(actionName + " (validation failed)");
      return { ok: false, validation: "failed", error: error.message,
        instruction: "Revise the plan and call the schedule tool again." };
    }
  }

  const handlers = {
    read_pending_tasks() {
      actions.push("read_pending_tasks");
      return { tasks: getPendingTasks() };
    },
    read_daily_availability() {
      actions.push("read_daily_availability");
      return { start: context.preferences.start, end: context.preferences.end,
        completedSlots: context.preferences.busySlots };
    },
    create_schedule(args) {
      return createSchedule(args, "create_schedule");
    },
    reschedule_pending_tasks(args) {
      return createSchedule(args, "reschedule_pending_tasks");
    },
    update_task_status(args) {
      const task = context.tasks.find((item) => item.id === args.taskId);
      if (!task || typeof args.completed !== "boolean") {
        return { ok: false, error: "Task id or status is invalid." };
      }
      if (!/complete|reopen|mark.*done|mark.*pending/i.test(context.goal)) {
        return { ok: false, error: "The user's goal does not authorize changing task status." };
      }
      task.completed = args.completed;
      actions.push("update_task_status");
      draftSchedule = null;
      finalSchedule = null;
      return { ok: true, task: { id: task.id, completed: task.completed } };
    },
    save_final_schedule() {
      if (!draftSchedule) return { ok: false, error: "There is no validated schedule to save." };
      finalSchedule = draftSchedule;
      actions.push("save_final_schedule");
      return { ok: true, saved: true };
    },
  };

  return {
    declarations: agentFunctionDeclarations,
    actions,
    execute(name, args) {
      const handler = handlers[name];
      if (!handler) return { ok: false, error: "Unknown application function." };
      if (name === "read_pending_tasks" || name === "read_daily_availability" || name === "save_final_schedule") {
        if (Object.keys(args || {}).length) return { ok: false, error: "This function takes no arguments." };
      }
      if (name === "create_schedule" || name === "reschedule_pending_tasks") {
        if (!Array.isArray(args?.events) || !Array.isArray(args?.unscheduledTaskIds) || typeof args?.explanation !== "string") {
          return { ok: false, validation: "failed", error: "Schedule plan fields are missing." };
        }
      }
      return handler(args || {});
    },
    getFinalSchedule() {
      return finalSchedule;
    },
    getTaskUpdates() {
      return context.tasks.map(({ id, completed }) => ({ id, completed }));
    },
  };
}
