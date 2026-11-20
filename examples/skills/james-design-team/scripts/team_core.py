"""Deterministic, offline planning and evidence checks for native design tasks."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

SURFACES = {
    "web": ["frontend", "typography"],
    "native": ["native-ui", "typography"],
    "social": ["social-copy", "social-visual", "typography"],
    "motion": ["storyboard", "video-production"],
    "brand": ["brand-identity", "typography"],
    "data": ["data-viz", "typography"],
    "presentation": ["presentation", "typography"],
    "print": ["print", "typography"],
    "email": ["email", "ux-copy", "typography"],
    "conversation": ["conversation", "ux-copy"],
    "spatial": ["spatial", "native-ui"],
}
BRAND_ALIASES = {
    "quick-track": "quicktrack", "quicktrack": "quicktrack",
    "d-festival": "dfestival", "dfestival": "dfestival",
    "fantasia": "fantasia", "james": "james",
}
CAPABILITY_ROLES = {
    "product-flow": "sophie", "ux-copy": "sophie", "research": "chloe",
    "analytics": "chloe", "design-system": "nathan", "figma": "noah",
    "typography": "emma", "hk-bilingual": "emma", "frontend": "noah",
    "native-ui": "noah", "art-direction": "art-director",
    "ui-motion": "motion-craft", "video-production": "motion-craft",
    "brand-identity": "isabella", "image-direction": "art-director",
}
REACT_STACKS = {"react", "next", "nextjs", "next.js", "react/next", "react/next.js"}

def unique(items):
    return list(dict.fromkeys(items))

def nonempty_string(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(name + " must be a nonempty string")
    return value.strip()

def string_list(value, name, required=False):
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(name + " must be an array of nonempty strings")
    if required and not value:
        raise ValueError(name + " must not be empty")
    return unique([x.strip() for x in value])

def brand_key(value):
    normalized = re.sub(r"[\s_]+", "-", nonempty_string(value, "brand").lower())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    if not normalized:
        raise ValueError("brand must contain an identifier")
    return BRAND_ALIASES.get(normalized, normalized)

def select_brand_context(request):
    """Copy only this brand's supplied context; never hold cross-request state."""
    key = brand_key(request.get("brand"))
    contexts = request.get("brandContexts", {})
    overrides = request.get("overrides", {})
    if not isinstance(contexts, dict) or not isinstance(overrides, dict):
        raise ValueError("brandContexts and overrides must be objects")
    matches = [v for k, v in contexts.items() if brand_key(k) == key]
    if len(matches) > 1:
        raise ValueError("Ambiguous duplicate aliases in brandContexts for " + key)
    context = deepcopy(matches[0]) if matches else {}
    if not isinstance(context, dict):
        raise ValueError("Selected brand context must be an object")
    if "brandId" in context and brand_key(context["brandId"]) != key:
        raise ValueError("Brand context identity does not match the requested brand")
    if "brandId" in overrides and brand_key(overrides["brandId"]) != key:
        raise ValueError("Overrides cannot change the requested brand identity")
    context.update(deepcopy(overrides))
    context["brandId"] = key
    return context

def plan_task(request, catalog, roles):
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    task_id = nonempty_string(request.get("taskId"), "taskId")
    brief = nonempty_string(request.get("brief"), "brief")
    surface = nonempty_string(request.get("surface"), "surface").lower()
    if surface not in SURFACES:
        raise ValueError("Unsupported surface: " + surface)
    languages = string_list(request.get("languages"), "languages", required=True)
    deliverables = string_list(request.get("deliverables"), "deliverables", required=True)
    stack = request.get("stack", "")
    if not isinstance(stack, str):
        raise ValueError("stack must be a string")
    owner = request.get("owner", roles["owners"][surface])
    role_ids = {r["id"] for r in roles["roles"]}
    if owner not in role_ids:
        raise ValueError("Unknown execution owner: " + str(owner))
    reviewer = roles["reviewer"]
    if reviewer == owner:
        reviewer = roles["reviewerFallback"]
    warnings = []
    context = select_brand_context(request)
    if len(context) == 1:
        warnings.append("No supplied brand context; use the current brief and inspect existing project sources without inventing brand facts.")
    selected = ["brief"] + SURFACES[surface] + ["accessibility", "visual-qa"]
    scope = request.get("scope", "standard")
    if scope in {"concept", "new-direction"}:
        selected.append("art-direction")
    requested_caps = string_list(request.get("requestedCapabilities", []), "requestedCapabilities")
    aliases = catalog.get("aliases", {})
    selected.extend(aliases.get(x, x) for x in requested_caps)
    if any(x.lower().startswith(("zh", "yue")) for x in languages):
        selected.append("hk-bilingual")
    by_id = {c["id"]: c for c in catalog["capabilities"]}
    capabilities, skills, references = [], [], []
    for capability_id in unique(selected):
        if capability_id not in by_id:
            warnings.append("Requested capability has no bundled method: " + capability_id)
            capabilities.append({"id": capability_id, "availability": "unverified"})
            continue
        capability = deepcopy(by_id[capability_id])
        capabilities.append(capability)
        skills.extend(capability["skills"])
        references.append(capability["reference"])
    if "ui-motion" in selected and surface == "web" and stack.strip().lower() in REACT_STACKS:
        skills.append("motion-foundations")
    known_skills = {s for c in catalog["capabilities"] for s in c["skills"]}
    known_skills.add("motion-foundations")
    requested_skills = string_list(request.get("requestedSkills", []), "requestedSkills")
    for skill in requested_skills:
        if skill not in known_skills:
            warnings.append("Explicit skill retained; native availability must be checked: " + skill)
    skills.extend(requested_skills)
    if "motion-foundations" in requested_skills and (surface != "web" or stack.strip().lower() not in REACT_STACKS):
        warnings.append("motion-foundations is React/Next-specific; keep requested access but do not apply its API rules to this platform.")
    collaborators = unique(CAPABILITY_ROLES[x] for x in selected if x in CAPABILITY_ROLES)
    collaborators = [x for x in collaborators if x not in {owner, reviewer, roles["coordinator"]}]
    return {
        "schemaVersion": 1, "taskId": task_id, "brand": context["brandId"],
        "surface": surface, "stack": stack, "brief": brief, "languages": languages,
        "requiredDeliverables": deliverables, "coordinator": roles["coordinator"],
        "owner": owner, "collaborators": collaborators, "reviewer": reviewer,
        "selectedCapabilities": capabilities, "selectedSkills": unique(skills),
        "references": unique(references + ["references/workflows/delivery.md"]),
        "brandContext": context, "warnings": warnings,
        "capabilityState": "configured",
        "evidenceRequirements": {
            "independentReview": True, "platform": surface,
            "requiredArtifacts": deliverables, "matchingContentVersion": True,
            "actualVisualFiles": True,
            "publication": "Only an authorized external action and verified readback can establish published."
        },
    }

def package_hashes(root):
    root = Path(root)
    hashes = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or any(x.startswith(".") or x == "__pycache__" for x in relative.parts):
            continue
        if relative.as_posix() in {"SKILL.md", "references/release.json"}:
            continue
        hashes[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return hashes, digest


def publication_key(fields):
    """Stable intent key to record before a platform call; never makes that call."""
    required = ("accountId", "channel", "taskId", "contentVersion")
    key_fields = {key: nonempty_string(fields.get(key), key) for key in required}
    # Distinguish optional channel variants without depending on dictionary order.
    for key in ("brand", "locale", "format", "destination"):
        if key in fields:
            key_fields[key] = nonempty_string(fields[key], key)
    return hashlib.sha256(json.dumps(key_fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def inspect_media(path):
    """Recognize export headers/trailers. Full decoding and visual review remain external."""
    import struct
    size = path.stat().st_size
    with path.open("rb") as stream:
        head = stream.read(64)
        stream.seek(max(0, size - 32))
        tail = stream.read(32)
    info = {"media": "other", "format": path.suffix.lower().lstrip("."), "size": size}
    if head.startswith(b"\x89PNG\r\n\x1a\n") and len(head) >= 33:
        width, height = struct.unpack(">II", head[16:24])
        if head[8:16] == b"\x00\x00\x00\rIHDR" and width and height and tail.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82"):
            info.update(media="image", format="png", width=width, height=height)
    elif head.startswith(b"\xff\xd8\xff") and tail.endswith(b"\xff\xd9") and size > 32:
        info.update(media="image", format="jpeg")
    elif head[:6] in (b"GIF87a", b"GIF89a") and len(head) >= 13 and tail.endswith(b";"):
        width, height = struct.unpack("<HH", head[6:10])
        if width and height:
            info.update(media="image", format="gif", width=width, height=height)
    elif head[:4] == b"RIFF" and head[8:12] == b"WEBP" and len(head) >= 30:
        if int.from_bytes(head[4:8], "little") + 8 == size:
            info.update(media="image", format="webp")
    elif head[4:8] == b"ftyp" and size >= 32:
        info.update(media="video", format="mp4")
    elif head[:4] == b"\x1aE\xdf\xa3" and size >= 32:
        info.update(media="video", format="webm")
    elif head.startswith(b"%PDF-") and b"%%EOF" in tail:
        info.update(media="document", format="pdf")
    return info

def expected_media(deliverable):
    name = deliverable.lower().replace("_", "-")
    if name in {"editable-source", "source", "implementation", "code", "design-source"}:
        return "source"
    if re.search(r"(^|[- /])(video|reel|animation|movie)(s)?($|[- /])", name):
        return "video"
    if re.search(r"(^|[- /])(carousel|story|poster|image|thumbnail|cover|screenshot|preview)(s)?($|[- /])", name):
        return "image"
    return "file"

def validate_delivery(plan, manifest, workspace):
    """Validate local files and supplied review/receipt evidence, not remote truth."""
    if not isinstance(plan, dict) or not isinstance(manifest, dict):
        raise ValueError("plan and manifest must be objects")
    required = string_list(plan.get("requiredDeliverables"), "requiredDeliverables", required=True)
    owner = nonempty_string(plan.get("owner"), "owner")
    reviewer = nonempty_string(plan.get("reviewer"), "reviewer")
    platform = nonempty_string(plan.get("surface"), "surface")
    if platform not in SURFACES:
        raise ValueError("Unsupported review platform: " + platform)
    status = manifest.get("status")
    if status not in {"draft", "rendered", "scheduled", "published", "failed", "unverified"}:
        raise ValueError("status must be draft, rendered, scheduled, published, failed or unverified")
    version = nonempty_string(manifest.get("contentVersion"), "contentVersion")
    artifacts = manifest.get("artifacts", [])
    if not isinstance(artifacts, list) or any(not isinstance(a, dict) for a in artifacts):
        raise ValueError("artifacts must be an array of objects")
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError("workspace must be an existing directory")
    errors, warnings, checks, covered, review_paths = [], [], [], set(), set()
    for artifact in artifacts:
        deliverable = nonempty_string(artifact.get("deliverable"), "artifact.deliverable")
        original_path = nonempty_string(artifact.get("path"), "artifact.path")
        path = (root / original_path).resolve()
        check = {"deliverable": deliverable, "path": original_path, "valid": False}
        checks.append(check)
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            errors.append("Artifact escapes task workspace: " + original_path)
            continue
        if not path.is_file() or path.stat().st_size == 0:
            errors.append("Missing or empty artifact: " + original_path)
            continue
        if artifact.get("contentVersion") != version:
            errors.append("Artifact contentVersion mismatch: " + original_path)
            continue
        info = inspect_media(path)
        check.update(info)
        kind = expected_media(deliverable)
        if kind in {"image", "video"} and info["media"] != kind:
            errors.append("Required " + kind + " is not a recognized rendered export: " + original_path)
            continue
        if kind == "source" and info["media"] in {"image", "video"}:
            errors.append("Editable source cannot be only a flattened image/video: " + original_path)
            continue
        if "dimensions" in artifact:
            dimensions = artifact["dimensions"]
            if (not isinstance(dimensions, list) or len(dimensions) != 2 or
                    dimensions != [info.get("width"), info.get("height")]):
                errors.append("Dimensions could not be verified or do not match: " + original_path)
                continue
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        check.update(valid=True, sha256=digest.hexdigest())
        if deliverable in required:
            covered.add(deliverable)
            review_paths.add(relative)
    for missing in required:
        if missing not in covered:
            errors.append("Required deliverable incomplete: " + missing)
    review = manifest.get("review", {})
    if not isinstance(review, dict):
        raise ValueError("review must be an object")
    if review.get("reviewerId") != reviewer or reviewer == owner:
        errors.append("Review must come from the assigned reviewer, independently of the execution owner")
    if review.get("result") != "pass" or review.get("blockingFindings"):
        errors.append("Independent review has not passed the required scope")
    if review.get("platform") != platform:
        errors.append("Review platform does not match the task surface")
    if review.get("contentVersion") != version:
        errors.append("Review contentVersion does not match the delivered version")
    evidence = review.get("evidence", [])
    if not isinstance(evidence, list) or any(not isinstance(x, str) for x in evidence):
        raise ValueError("review.evidence must be an array of artifact paths")
    inspected = set()
    for item in evidence:
        try:
            inspected.add((root / item).resolve().relative_to(root).as_posix())
        except ValueError:
            errors.append("Review evidence escapes task workspace: " + item)
    if not review_paths.issubset(inspected):
        errors.append("Review evidence does not cover every required artifact")
    publication_valid = True
    if status in {"scheduled", "published"}:
        publication = manifest.get("publication", {})
        if not isinstance(publication, dict):
            raise ValueError("publication must be an object")
        readback = publication.get("readback", {})
        if not isinstance(readback, dict):
            readback = {}
        fields = ["accountId", "channel", "contentVersion"]
        fields += ["postId", "permalink"] if status == "published" else ["jobId", "scheduledAt"]
        publication_valid = readback.get("confirmed") is True and publication.get("contentVersion") == version
        for key in fields:
            value = publication.get(key)
            if not isinstance(value, str) or not value.strip() or readback.get(key) != value:
                publication_valid = False
        if status == "published":
            from urllib.parse import urlparse
            url = urlparse(str(publication.get("permalink", "")))
            publication_valid = publication_valid and url.scheme == "https" and bool(url.netloc)
        if status == "scheduled" and publication_valid:
            from datetime import datetime
            try:
                parsed = datetime.fromisoformat(publication["scheduledAt"].replace("Z", "+00:00"))
                publication_valid = parsed.tzinfo is not None
            except ValueError:
                publication_valid = False
        if not publication_valid:
            errors.append("Publication/schedule receipt lacks a matching positive readback")
    state = status
    next_action = "none"
    if status == "unverified" or not publication_valid:
        state, next_action = "unverified", "read_back_before_retry"
    elif errors:
        state, next_action = "incomplete", "complete_missing_evidence"
    elif status in {"draft", "failed"}:
        next_action = "continue_production" if status == "draft" else "resolve_failure"
    if status in {"draft", "failed"}:
        state = status
    verified = not errors and status in {"rendered", "scheduled", "published"} and publication_valid
    warnings.append("File signatures and hashes do not replace actual rendering, decoding, interaction or accessibility inspection.")
    return {
        "verified": verified, "state": state, "errors": errors, "warnings": warnings,
        "nextAction": next_action, "artifactChecks": checks, "contentVersion": version,
        "evidenceScope": "Local file checks and supplied review/publication receipts; no independent remote platform authentication or aesthetic judgment."
    }
