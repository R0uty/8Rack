import { Plus, Target } from "lucide-react";
import { EmptyState } from "./ui";
import { useAppNav } from "../lib/appNav";

export function NoMission() {
  const { newMission } = useAppNav();
  return (
    <EmptyState icon={Target} title="No mission selected" action={{ label: "New mission", icon: Plus, onClick: newMission }}>
      Everything here is scoped to a mission: its targets, the rules of engagement, and what the factory finds.
      Create one, or pick one in the sidebar.
    </EmptyState>
  );
}
