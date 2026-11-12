import {
  generateGeminiSchedule,
  ScheduleError,
  validateScheduleRequest,
} from "../services/scheduleService.js";

export async function postSchedule(request, response, next) {
  try {
    const scheduleRequest = validateScheduleRequest(request.body);
    const goal = typeof request.body.goal === "string" ? request.body.goal.slice(0, 500) : "Plan my day and schedule my pending tasks.";
    const schedule = await generateGeminiSchedule(scheduleRequest, goal);
    response.json(schedule);
  } catch (error) {
    if (error instanceof ScheduleError) {
      return response.status(error.status).json({
        error: error.message,
        code: error.code,
      });
    }
    next(error);
  }
}
