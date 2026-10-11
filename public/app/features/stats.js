// TODO: stats 機能（担当エージェントが実装）
import { html, mount, setHeader } from "../core.js";
import { empty } from "../ui.js";

export default {
  name: "stats",
  routes: {
    "/stats": (view) => {
      setHeader({ title: "成績" });
      mount(view, empty("準備中です", { icon: "🚧" }));
    },
  },
  homeCards: [],
  menu: [],
};
