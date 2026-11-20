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
