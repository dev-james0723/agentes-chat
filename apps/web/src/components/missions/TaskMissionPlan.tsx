import { type Mission, type ThreadInfo, useMission } from "@agenteschat/client";
import { Button, Dialog, DialogBody, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { MissionPlanCard } from "./MissionCards";
import { useMissionRepositoryDraft } from "./MissionRepositoryFolder";

type TaskMissionPlanProps = { mission: Mission; thread: ThreadInfo };

/** A task keeps its proposed mission reachable even when its original plan card is far up the conversation. */
export function TaskMissionPlan({ mission, thread }: TaskMissionPlanProps) {
  if (
    thread.channelKind !== "task" ||
    mission.threadId !== thread.id ||
    mission.channelId !== thread.channelId ||
    mission.status !== "proposed"
  )
    return null;

  return <TaskMissionReview mission={mission} thread={thread} />;
}

function TaskMissionReview({ mission, thread }: TaskMissionPlanProps) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const { data: detail } = useMission(org.id, mission.id);
  // The dialog contents can unmount before Save returns. Keep observing this task's draft.
  useMissionRepositoryDraft(
    org.id,
    mission.id,
    detail?.id === mission.id && detail.threadId === thread.id && detail.channelId === thread.channelId
      ? detail
      : undefined,
  );

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
