
import { createPaseoClient } from "@getpaseo/client";

async function main() {
  const client = createPaseoClient({ home: process.env.HOME + "/.paseo" });
  await client.connect();

  const snap = await client.providers.waitForReady();
  const available = (snap.providers ?? []).filter((p: any) => p.available);
  console.log("available:", available.map((p: any) => p.id).join(", "));

  for (const p of available) {
    try {
      const modes = await client.providers.listModes(p.id as any);
      const models = await client.providers.listModels(p.id as any);
      console.log("\n---", p.id);
      console.log("modes:", JSON.stringify(modes.modes?.map((m: any) => ({id: m.id, label: m.label}))));
      const mdls = models.models?.slice(0,4).map((m: any) => ({id: m.id, label: m.label, isDefault: m.isDefault}));
      console.log("models:", JSON.stringify(mdls));
    } catch(e: any) { console.log(p.id, "error:", e.message?.slice(0,100)); }
  }

  await client.close();
}

main().catch(console.error);
