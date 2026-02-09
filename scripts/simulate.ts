/**
 * Script to run a full /casino/simulateRound end-to-end.
 * Usage: pnpm simulate
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function main() {
  console.log("Running /casino/simulateRound ...\n");

  const res = await fetch(`${BASE_URL}/casino/simulateRound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: 1,
      gameId: 1,
      currency: "USD",
    }),
  });

  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Response:", JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
