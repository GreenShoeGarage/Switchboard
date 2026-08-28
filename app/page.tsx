import { SwitchboardWorkbench } from "./switchboard-workbench";
import { requireOperatorUser } from "./operator-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireOperatorUser("/");
  return <SwitchboardWorkbench />;
}
