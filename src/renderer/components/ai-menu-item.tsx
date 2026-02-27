import { Renderer } from "@freelensapp/extensions";
import { aiDrawerStore } from "../stores/ai-drawer-store";

type KubeObject = Renderer.K8sApi.KubeObject;

interface AIMenuItemProps {
  object: KubeObject;
  toolbar?: boolean;
}

export function AIMenuItem({ object, toolbar }: AIMenuItemProps) {
  const kind = (object as any)?.kind || "Unknown";

  const handleClick = () => {
    aiDrawerStore.open(object, kind);
  };

  return (
    <Renderer.Component.MenuItem onClick={handleClick}>
      <Renderer.Component.Icon material="psychology" tooltip="Analyze with AI" />
      {!toolbar && <span>Analyze with AI</span>}
    </Renderer.Component.MenuItem>
  );
}
