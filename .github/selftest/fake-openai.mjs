// A fake OpenAI-compatible server for the Action self-test.
// It "translates" by adding "[<locale>] " in front of each string, so no
// paid API is called. Same logic as startFakeOpenAI in action/test/helpers/env.mjs.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      const body = JSON.parse(raw);
      const user = body.messages.find((m) => m.role === "user").content;
      const locale = user.match(/^Target language: .*\(([^)]+)\)$/m)[1];
      const json = user.split("Strings to translate (JSON):\n")[1].split("\n\nReturn {")[0];
      const translations = JSON.parse(json).map((i) => ({ key: i.key, text: `[${locale}] ${i.text}` }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations }) } }] }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`fake OpenAI on http://127.0.0.1:${port}/v1`));
