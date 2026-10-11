// TODO: schedule 機能（担当エージェントが実装）
import { html, mount, setHeader } from "../core.js";
import { empty } from "../ui.js";

export default {
  name: "schedule",
  routes: {
    "/schedule": (view) => {
      setHeader({ title: "日程" });
      mount(view, empty("準備中です", { icon: "🚧" }));
    },
  },
  homeCards: [],
  menu: [],
};
