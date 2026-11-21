import type { Mission, ThreadInfo } from "@agenteschat/client";
import { Button, Dialog, DialogBody, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MissionPlanCard } from "./MissionCards";

/** A task keeps its proposed mission reachable even when its original plan card is far up the conversation. */
export function TaskMissionPlan({ mission, thread }: { mission: Mission; thread: ThreadInfo }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (
    thread.channelKind !== "task" ||
    mission.threadId !== thread.id ||
    mission.channelId !== thread.channelId ||
    mission.status !== "proposed"
  )
    return null;

  return (
    <>
      <div className="channel__notice ac-actline" data-task-mission={mission.id}>
        <span className="ac-iconline">
          <Icon name="document" size={16} />
          <span>{mission.title}</span>
        </span>
        <Button size="sm" icon="document" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          {t("missions.plan.see")}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen} title={mission.title} closeLabel={t("common.close")}>
        <DialogBody>
          <MissionPlanCard
            threadId={thread.id}
            channelId={thread.channelId}
            onNavigate={(navigate) => {
              setOpen(false);
              setTimeout(navigate, 0);
            }}
            plan={{
              missionId: mission.id,
              title: mission.title,
              goal: mission.goal,
              computer: mission.machine?.name ?? "",
              executor: mission.executor,
            }}
          />
        </DialogBody>
      </Dialog>
    </>
  );
}
