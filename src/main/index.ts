import { Main } from "@freelensapp/extensions";

export default class FreeLensAIMain extends Main.LensExtension {
  async onActivate(): Promise<void> {
    console.log("[FreeLens AI] Main process activated");
  }

  async onDeactivate(): Promise<void> {
    console.log("[FreeLens AI] Main process deactivated");
  }
}
