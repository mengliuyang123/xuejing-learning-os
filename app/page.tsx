import Workbench from "../components/workbench/Workbench";
import "../components/workbench/workbench.css";
import { today } from "../lib/learning";
import { getServerModelSummary } from "../lib/ai-config";

export const dynamic = "force-dynamic";

export default function Home() {
  const summary = getServerModelSummary();
  return (
    <Workbench
      now={today()}
      live={summary.configured}
      serverModelName={summary.modelId}
    />
  );
}
