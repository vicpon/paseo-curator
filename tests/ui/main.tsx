import { createRoot } from "react-dom/client";
import { CuratorSettings } from "../../client/settings";
import "./style.css";

createRoot(document.getElementById("root")!).render(<main>
  <aside>Browser test harness · Actual Curator component · HTML host controls · Fixture catalog and models · No live plugin reload</aside>
  <CuratorSettings theme={{ colors: {
    surface0: "#171b19", surface1: "#202421", surface2: "#272c29", border: "#303632",
    foreground: "#eeeeee", foregroundMuted: "#aaaaaa", accent: "#8fb996", accentForeground: "#171b19",
    statusSuccess: "#8fb996", statusWarning: "#e0b25c", statusDanger: "#d48471",
  } }} />
</main>);
