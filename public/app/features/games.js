// TODO: games 機能（担当エージェントが実装）
import { html, mount, setHeader } from "../core.js";
import { empty } from "../ui.js";

export default {
  name: "games",
  routes: {
    "/games": (view) => {
      setHeader({ title: "試合" });
      mount(view, empty("準備中です", { icon: "🚧" }));
    },
  },
  homeCards: [],
  menu: [],
};
