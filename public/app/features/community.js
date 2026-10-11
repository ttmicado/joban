// TODO: community 機能（担当エージェントが実装）
import { html, mount, setHeader } from "../core.js";
import { empty } from "../ui.js";

export default {
  name: "community",
  routes: {
    "/team": (view) => {
      setHeader({ title: "チーム" });
      mount(view, empty("準備中です", { icon: "🚧" }));
    },
  },
  homeCards: [],
  menu: [],
};
