import { createHttpServer } from "./http.ts";

const port = Number(process.env.OR1_PORT ?? 4310);
const host = process.env.OR1_HOST ?? "127.0.0.1";

createHttpServer().listen(port, host, () => {
  console.log(`or1 server listening on http://${host}:${port}`);
});
