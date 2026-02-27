import { Renderer } from "@freelensapp/extensions";
import { getCachedAnalysis } from "../services/analyze";
import { aiDrawerStore } from "../stores/ai-drawer-store";
import { HEALTH_COLORS } from "./analysis-results";

type KubeObject = Renderer.K8sApi.KubeObject;

interface AITriggerButtonProps {
  object: KubeObject;
}

export function AITriggerButton({ object }: AITriggerButtonProps) {
  const meta = (object as any)?.metadata || {};
  const kind = (object as any)?.kind || "Unknown";
  const uid = meta.uid || `${kind}/${meta.namespace || ""}/${meta.name}`;

  const cached = getCachedAnalysis(uid);

  const handleClick = () => {
    aiDrawerStore.open(object, kind);
  };

  return (
    <div className="flai-trigger">
      <button
        type="button"
        className="flai-btn flai-btn--primary"
        onClick={handleClick}
      >
        {cached ? "View AI Analysis" : "Analyze with AI"}
      </button>
      {cached && (
        <span
          className="flai-badge flai-badge--small"
          style={{ backgroundColor: HEALTH_COLORS[cached.data.health] || HEALTH_COLORS.unknown }}
        >
          {cached.data.health}
        </span>
      )}
    </div>
  );
}
