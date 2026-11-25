import type { Issue, FounderStatus as Status } from "@agenteschat/client";
import { useIssueFounderStatus } from "@agenteschat/client";
import { AttentionNote, Chip, DetailsSection } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { DetailsLink } from "@/components/details-link";
import { useOrg } from "@/components/org-context";
import "./founder-status.css";

/**
 * A task's status from stored evidence only (ADR 0204): the server words it in Hong Kong Chinese, so the lines carry
 * `lang="zh-HK"`. "Needs you" links to the approval's own details, the card that decides it: nothing here asks again.
 */
export function FounderStatusSection({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const status = useIssueFounderStatus(org.id, issue.id, issue.updatedAt);
  if (!status.data) return null;
  return (
    <DetailsSection title={t("issues.founder.title")} className="founder-status">
      <FounderStatusBody status={status.data} />
    </DetailsSection>
  );
}

export function FounderStatusBody({ status: s }: { status: Status }) {
  const { t } = useTranslation();
  return (
    <div className="founder-status__body">
      <div className="founder-status__chips">
        <Chip tone={s.delivery.available ? "done" : "neutral"}>
          {s.delivery.available ? t("issues.founder.available") : t("issues.founder.notAvailable")}
        </Chip>
        <Chip tone={s.verification.verified ? "done" : "neutral"}>
          {s.verification.verified ? t("issues.founder.verified") : t("issues.founder.notVerified")}
        </Chip>
        {s.needsMe.needed && <Chip tone="waiting">{t("issues.founder.needsYou")}</Chip>}
      </div>
      {s.needsMe.decisions.map((d) => (
        <AttentionNote key={d.approvalId} className="founder-status__decision">
          <DetailsLink item={{ kind: "approval", id: d.approvalId }} className="ac-link" lang="zh-HK">
            {d.title}
          </DetailsLink>
        </AttentionNote>
      ))}
      <ul className="founder-status__lines" lang="zh-HK">
        {[s.changed.text, s.delivery.text, s.verification.text, ...blockerLines(s), s.next.text, s.needsMe.text].map(
          (line) => (
            <li key={line}>{line}</li>
          ),
        )}
      </ul>
    </div>
  );
}

const blockerLines = (s: Status) => (s.blockers.length ? [`阻礙：${s.blockers.map((b) => b.text).join("，")}。`] : []);
