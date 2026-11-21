import { cacheMission, keys, type Mission } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Field, Input } from "@agenteschat/ui";
import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";

const MAX_FOLDER_LENGTH = 300;

function validFolder(value: string) {
  const folder = value.trim().replace(/\\/g, "/");
  return (
    value.length <= MAX_FOLDER_LENGTH &&
    folder.length > 0 &&
    !folder.startsWith("/") &&
    !/^[a-zA-Z]:/.test(folder) &&
    !folder.split("/").includes("..")
  );
}

function canEditFolder(mission: Mission, userId: string) {
  return (
    mission.role === "owner" &&
    mission.ownerId === userId &&
    mission.status === "proposed" &&
    mission.runningTasks === 0 &&
    mission.machine !== null
  );
}

interface FolderDraft {
  value: string;
  error?: string;
}

export function useMissionRepositoryFolder(missionId: string, mission: Mission | undefined) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const missionKey = keys.mission(org.id, missionId);
  const machineId = mission?.machine?.id;
  const savedFolder = mission?.repoDir ?? "";
  // The timeline card and the review dialog share the draft while either is mounted on this binding.
  const draftKey = ["mission-folder-draft", org.id, missionId, machineId, savedFolder] as const;
  const { data: draft } = useQuery<FolderDraft | null>({ queryKey: draftKey, queryFn: skipToken, gcTime: 0 });
  const mutationKey = ["mission-folder-save", org.id, missionId] as const;
  const pendingFilter = { mutationKey, exact: true };
  const startFilter = { mutationKey: keys.missionPart(org.id, missionId, "control"), exact: true };
  const pending = useIsMutating(pendingFilter) > 0;
  const startPending = useIsMutating(startFilter) > 0;
  const mutationPending = () => qc.isMutating(pendingFilter) > 0 || qc.isMutating(startFilter) > 0;
  const save = useMutation({
    mutationKey,
    meta: { silent: true },
    mutationFn: (input: { machineId: string; folder: string; draftKey: typeof draftKey }) =>
      api.missions.setMachine(org.id, missionId, input.machineId, input.folder),
    onSuccess: (saved, input) => {
      const current = qc.getQueryData<Mission | null>(keys.threadMission(org.id, saved.threadId));
      // A save can finish after the task has bound a different mission.
      if (current !== undefined && current?.id !== saved.id) qc.setQueryData(keys.mission(org.id, saved.id), saved);
      else cacheMission(qc, org.id, saved);
      qc.setQueryData<FolderDraft | null>(input.draftKey, (draft) => (draft ? null : undefined));
    },
    onError: (error, input) =>
      qc.setQueryData<FolderDraft>(input.draftKey, (current) => current && { ...current, error: errorText(t, error) }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = qc.getQueryData<Mission>(missionKey);
    const folder = qc.getQueryData<FolderDraft | null>(draftKey)?.value;
    if (
      !mission ||
      !current ||
      !machineId ||
      !canEditFolder(current, me.user.id) ||
      current.id !== missionId ||
      current.threadId !== mission.threadId ||
      current.channelId !== mission.channelId ||
      current.machine?.id !== machineId ||
      current.repoDir !== savedFolder ||
      folder === undefined ||
      !validFolder(folder) ||
      mutationPending()
    )
      return;
    save.mutate({ machineId, folder, draftKey });
  };

  const value = draft?.value ?? savedFolder;
  const input = useRef<HTMLInputElement>(null);
  // The input updates at typing speed. The shared draft also mirrors edits from another plan card.
  useLayoutEffect(() => {
    const field = input.current;
    if (field && field.value !== value) field.value = value;
  }, [value]);
  const invalid = Boolean(draft && !validFolder(draft.value));
  const editor = mission && canEditFolder(mission, me.user.id) && (
    <form className="mi-plan__folder" onSubmit={submit}>
      <Field
        label={t("missions.plan.repositoryFolder")}
        example={t("missions.plan.repositoryFolderRelative")}
        error={invalid ? t("errors.mission.badFolder") : draft?.error && <span role="alert">{draft.error}</span>}
        labelAside={
          <Button type="submit" size="sm" disabled={!draft || invalid || startPending} loading={pending}>
            {t("common.save")}
          </Button>
        }
      >
        <Input
          ref={input}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAX_FOLDER_LENGTH}
          defaultValue={value}
          disabled={pending || startPending}
          onChange={(event) => {
            if (mutationPending()) return;
            const value = event.target.value;
            qc.setQueryData<FolderDraft | null>(draftKey, value === savedFolder ? null : { value });
          }}
        />
      </Field>
    </form>
  );

  return {
    editor,
    startBlocked: Boolean(draft) || pending || startPending,
    blocksStart: () => Boolean(qc.getQueryData(draftKey)) || mutationPending(),
  };
}
