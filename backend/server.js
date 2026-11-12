import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import scheduleRoutes from "./routes/scheduleRoutes.js";

const app = express();
const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(backendDirectory, "..");
dotenv.config({ path: path.join(backendDirectory, ".env") });
const port = Number(process.env.PORT) || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use("/api/schedule", scheduleRoutes);

app.get("/", (request, response) => {
  response.sendFile(path.join(projectDirectory, "index.html"));
});
app.get("/index.html", (request, response) => {
  response.sendFile(path.join(projectDirectory, "index.html"));
});
app.get("/style.css", (request, response) => {
  response.sendFile(path.join(projectDirectory, "style.css"));
});
app.get("/script.js", (request, response) => {
  response.sendFile(path.join(projectDirectory, "script.js"));
});

app.use((error, request, response, next) => {
  if (error.type === "entity.too.large") {
    return response.status(413).json({ error: "Request body is too large.", code: "REQUEST_TOO_LARGE" });
  }
  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "Request body must contain valid JSON.", code: "INVALID_JSON" });
  }
  console.error("Request failed:", error.message);
  response.status(500).json({ error: "An unexpected server error occurred.", code: "SERVER_ERROR" });
});

app.listen(port, () => {
  console.log("DayPilot AI is available at http://localhost:" + port);
});
