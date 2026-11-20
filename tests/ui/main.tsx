import { createRoot } from "react-dom/client";
import { CuratorSettings } from "../../client/settings";
import "./style.css";

createRoot(document.getElementById("root")!).render(<main>
  <aside>Browser test harness · Actual Curator component · HTML host controls · Fixture catalog and models · No live plugin reload</aside>
  <CuratorSettings />
</main>);
