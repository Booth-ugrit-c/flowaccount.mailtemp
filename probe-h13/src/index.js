const buffered = [];

// Iteration cap: Date.now() is frozen during sync CPU work in production (ms reads 0 there)
function busyLoop(ms) {
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end && n < 2_500_000) n++;
  return n;
}

export default {
  async email(message) {
    const started = Date.now();
    const variant = message.to.split("@")[0];
    const record = (outcome, iterations) => console.log(JSON.stringify({ to: message.to, rawSize: message.rawSize, variant, outcome, iterations, ms: Date.now() - started }));

    if (variant === "h13-throw") {
      record("throw");
      throw new Error("h13 throw");
    }
    if (variant === "h13-reject") {
      record("reject");
      message.setReject("h13 control");
      return;
    }
    if (variant === "h13-cpu") {
      const iterations = busyLoop(200);
      record("cpu", iterations);
      return;
    }
    buffered.push(await new Response(message.raw).arrayBuffer());
    if (buffered.length > 20) buffered.shift();
    record("return");
  },
};
