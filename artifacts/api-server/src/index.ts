import app from "./app.js";

const port = Number(process.env.PORT || process.env.API_PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

app.listen(port, host, () => {
  console.log(`OpenRouter compatible proxy listening on http://${host}:${port}`);
});
