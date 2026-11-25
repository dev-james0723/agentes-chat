import { type Agent, keys } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { ImageCropDialog } from "@/components/ProfilePhoto";
import { useToast } from "@/lib/toast";

/** A saved agent photo, shared by every place that shows this agent. */
export function AgentPhotoDialog({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const done = () => {
    void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
    void qc.invalidateQueries({ queryKey: keys.agentDetail(org.id, agent.id) });
    void qc.invalidateQueries({ queryKey: keys.team(org.id) });
  };
  return (
    <ImageCropDialog
      open={open}
      onClose={onClose}
      title={t("photo.title")}
      help={t("photo.help")}
      placeholder={<AgentAvatar agent={agent} name={agent.name} size="lg" />}
      hasImage={Boolean(agent.avatarUrl)}
      removeLabel={t("photo.remove")}
      format="image/png"
      save={({ imageBase64, contentType }) =>
        api.agents.setAgentAvatar(org.id, agent.id, { data: imageBase64, contentType })
      }
      remove={() => api.agents.removeAgentAvatar(org.id, agent.id)}
      onSaved={() => {
        done();
        toast.show(t("photo.saved"));
      }}
      onRemoved={() => {
        done();
        toast.show(t("photo.removed"));
      }}
    />
  );
}
