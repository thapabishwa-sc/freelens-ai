import { Renderer, Common } from "@freelensapp/extensions";
import { extractContainers, extractOwnerRef, type ContainerInfo } from "../utils/pod-utils";
import { logPanelStore } from "../stores/log-panel-store";

type KubeObject = Renderer.K8sApi.KubeObject;

const { MenuItem, SubMenu, Icon, StatusBrick } = Renderer.Component;
const prevDefault = Common.Util.prevDefault;

interface AILogMenuItemProps {
  object: KubeObject;
  toolbar?: boolean;
}

function statusColor(info: ContainerInfo): string {
  if (info.status === "running") return "var(--colorSuccess, #22c55e)";
  if (info.status === "terminated") return "var(--textColorDimmed, #999)";
  return "var(--textColorTertiary, #bbb)";
}

export function AILogMenuItem({ object, toolbar }: AILogMenuItemProps) {
  const meta = (object as any)?.metadata || {};
  const namespace = meta.namespace || "";
  const podName = meta.name || "";
  const containers = extractContainers(object);

  const openLogAnalysis = (c: ContainerInfo) => {
    const ownerRef = extractOwnerRef(object);
    logPanelStore.openTab(namespace, podName, c.name, c.isInit, undefined, undefined, ownerRef);
  };

  if (!containers.length) return null;

  return (
    <MenuItem onClick={prevDefault(() => openLogAnalysis(containers[0]))}>
      <Icon
        material="troubleshoot"
        interactive={toolbar}
        tooltip={toolbar ? "AI Log Analysis" : undefined}
      />
      <span className="title">AI Log Analysis</span>
      {containers.length > 1 && (
        <>
          <Icon className="arrow" material="keyboard_arrow_right" />
          <SubMenu>
            {containers.map((c) => (
              <MenuItem
                key={c.name}
                onClick={prevDefault(() => openLogAnalysis(c))}
                className="flex align-center"
              >
                <StatusBrick style={{ backgroundColor: statusColor(c) }} />
                <span>{c.name}</span>
              </MenuItem>
            ))}
          </SubMenu>
        </>
      )}
    </MenuItem>
  );
}
