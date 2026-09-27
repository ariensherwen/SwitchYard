import { ensureSwitchYardHome } from "./home.ts";
import { StateStore } from "./state.ts";

export async function openSwitchYard() {
  const paths = await ensureSwitchYardHome();
  const store = new StateStore(paths.database);
  return { paths, store };
}
