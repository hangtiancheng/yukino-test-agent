import { createRoot } from "@yukino.js/lit-jsx";

import { createBrowserRouter } from "./app-router";
import { routes } from "./router";

import "./styles.css";

createBrowserRouter(routes);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<route-view />);
}
