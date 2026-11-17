import type { IssueFounderUpdate } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { useId, useState } from "react";

const copy = {
  en: {
    title: "Outcome update",
    evidence: "Engineering evidence",
    unknownChecks: "No check results recorded",
    noEvidence: "No authorized receipt data",
    how: "How to try",
    remaining: "Remaining work",
    blocker: "Blocker",
    next: "Next owner",
    unassigned: "Not assigned",
    agent: "Assigned agent",
    person: "Assigned person",
    decision: "A response is needed in the task conversation",
    updated: "Last updated",
    copy: "Copy evidence",
    copied: "Copied",
    copyFailed: "Copy unavailable",
    noStage: "No current delivery proof",
    availability: {
      not_available: "Not available",
      local: "Local only",
      preview: "Preview only",
      production: "Available in production",
      unknown: "Availability unknown",
    },
  },
  pt: {
    title: "Atualização da tarefa",
    evidence: "Evidências técnicas",
    unknownChecks: "Nenhum resultado de verificação registrado",
    noEvidence: "Nenhum comprovante autorizado disponível",
    how: "Como experimentar",
    remaining: "Trabalho restante",
    blocker: "Impedimento",
    next: "Próximo responsável",
    unassigned: "Não atribuído",
    agent: "Agente responsável",
    person: "Pessoa responsável",
    decision: "Uma resposta é necessária na conversa da tarefa",
    updated: "Última atualização",
    copy: "Copiar evidências",
    copied: "Copiado",
    copyFailed: "Cópia indisponível",
    noStage: "Sem comprovação atual da entrega",
    availability: {
      not_available: "Indisponível",
      local: "Somente local",
      preview: "Somente prévia",
      production: "Disponível em produção",
      unknown: "Disponibilidade desconhecida",
    },
  },
  zh: {
    title: "任務更新",
    evidence: "工程證據",
    unknownChecks: "尚無檢查結果紀錄",
    noEvidence: "尚無獲授權的驗證紀錄",
    how: "如何試用",
    remaining: "剩餘工作",
    blocker: "阻礙",
    next: "下一位負責人",
    unassigned: "尚未指派",
    agent: "已指派的代理",
    person: "已指派的人員",
    decision: "請在任務對話回應所需事項",
    updated: "最後更新",
    copy: "複製證據",
    copied: "已複製",
    copyFailed: "暫時無法複製",
    noStage: "尚無目前交付版本的證明",
    availability: {
      not_available: "尚未提供",
      local: "只可在本機使用",
      preview: "只供預覽",
      production: "正式環境可用",
      unknown: "可用情況未明",
    },
  },
};

function updatedTime(update: IssueFounderUpdate): string {
  try {
    return new Date(update.generatedAt).toLocaleString(update.locale, {
      timeZone: update.timeZone ?? "UTC",
      timeZoneName: "short",
    });
  } catch {
    return update.generatedAt;
  }
}

/** Read-only authorized API projection. Evidence IDs are text, never automatic external links. */
export function OutcomeUpdateCard({ update, ownerName }: { update: IssueFounderUpdate; ownerName?: string }) {
  const labels = copy[update.locale.startsWith("zh") ? "zh" : update.locale.startsWith("pt") ? "pt" : "en"];
  const [expanded, setExpanded] = useState(update.style === "technical");
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const evidenceId = useId();
  const checks = update.checks;
  const occurrences = new Map<string, number>();
  const remaining = update.remaining.map((text) => {
    const occurrence = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, occurrence);
    return { key: JSON.stringify([text, occurrence]), text };
  });
  const counts =
    checks &&
    (update.locale.startsWith("zh")
      ? `通過 ${checks.passed} 項，失敗 ${checks.failed} 項，未執行 ${checks.notRun} 項`
      : update.locale.startsWith("pt")
        ? `${checks.passed} aprovadas, ${checks.failed} falharam, ${checks.notRun} não executadas`
        : `${checks.passed} passed, ${checks.failed} failed, ${checks.notRun} not run`);
  const copyEvidence = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            taskId: update.taskId,
            taskRevision: update.taskRevision,
            deliveryStage: update.deliveryStage,
            availability: update.availability,
            checks,
            evidence: update.evidence,
          },
          null,
          2,
        ),
      );
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <section
      lang={update.locale}
      aria-label={labels.title}
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--card-pad)",
        borderRadius: "var(--radius-section)",
        background: "var(--sunken)",
        overflowWrap: "anywhere",
        minWidth: 0,
      }}
    >
      <h3 style={{ margin: 0 }}>{labels.title}</h3>
      <p role="status" aria-live="polite" aria-atomic="true">
        {update.outcome}
      </p>
      <p>
        <strong>{labels.availability[update.availability]}</strong>
      </p>
      <p>{counts ?? labels.unknownChecks}</p>
      {update.howToTry && (
        <div>
          <strong>{labels.how}</strong>
          <p>{update.howToTry}</p>
        </div>
      )}
      {update.remaining.length > 0 && (
        <div>
          <strong>{labels.remaining}</strong>
          <ul>
            {remaining.map((item) => (
              <li key={item.key}>{item.text}</li>
            ))}
          </ul>
        </div>
      )}
      {update.blocker && (
        <div>
          <strong>{labels.blocker}</strong>
          <p>{update.blocker.summary}</p>
          <p>{update.blocker.nextAdmissibleAction}</p>
        </div>
      )}
      <p>
        {labels.next}:{" "}
        {ownerName ??
          (update.nextOwner ? (update.nextOwner.type === "agent" ? labels.agent : labels.person) : labels.unassigned)}
      </p>
      {update.decisionNeeded && (
        <p>
          <strong>{labels.decision}</strong>
        </p>
      )}
      <p className="small muted">
        {labels.updated}: <time dateTime={update.generatedAt}>{updatedTime(update)}</time>
      </p>
      <div className="ac-acts">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={evidenceId}
          onClick={() => setExpanded((value) => !value)}
        >
          {labels.evidence}
        </Button>
      </div>
      {expanded && (
        <section
          id={evidenceId}
          aria-label={labels.evidence}
          style={{ display: "grid", gap: "var(--space-3)", minWidth: 0 }}
        >
          <p className="small muted">
            {update.taskId} / {update.taskRevision}
          </p>
          <p>{update.deliveryStage ?? labels.noStage}</p>
          {checks && <p>{checks.scope}</p>}
          {update.evidence.length === 0 ? (
            <p>{labels.noEvidence}</p>
          ) : (
            <ul>
              {update.evidence.map((item) => (
                <li key={item.id}>
                  {item.id}: {item.status}, {item.environment}, {item.sourceRevision ?? labels.noStage},{" "}
                  {item.stage ?? labels.noStage}
                </li>
              ))}
            </ul>
          )}
          <div className="ac-acts">
            <Button variant="ghost" size="sm" onClick={() => void copyEvidence()}>
              {labels.copy}
            </Button>
          </div>
          {copied && <p role="status">{copied === "copied" ? labels.copied : labels.copyFailed}</p>}
        </section>
      )}
    </section>
  );
}
