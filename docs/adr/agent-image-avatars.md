# Agent image avatars

Status: Accepted

## Context

Agents currently keep a pixel appearance. People need to upload a portrait while keeping the agent's identity, capabilities and original appearance. The existing profile-photo and workspace-logo pipeline already validates image types, removes metadata and stores content-addressed images.

## Decision

Add a nullable `agents.avatar_url` column and expose it as `avatarUrl` in agent and former-agent views. It is separate from `appearance`, which remains the default and image-load fallback. Existing agent records and all capability fields are preserved.

An agent owner or a workspace administrator may upload or remove a portrait through the dedicated agent-avatar API. The upload accepts base64 JPEG, PNG or WebP, up to 2 MB; the server checks required image payloads and chunk boundaries (PNG also checks CRCs and bounded decompression), dimensions and ending, removes metadata without resampling pixels, and stores it in the platform BlobStore. It accepts no caller-supplied image URL.

The stable image address contains the organization, agent and a content hash. Reads require membership of that organization and the agent's current asset reference. The response is private and immutable, with an inert image content type. Archived and deleted authors retain their current portrait for existing conversations.

An update changes only the portrait reference and modification time. It is audited, invalidates the agent caches and publishes the existing agent and machine change events. The update locks the agent row; old-image cleanup rechecks the current reference under that lock so a concurrent restoration cannot lose its image.

The web uses the common agent-avatar component, with a shared image-error fallback to its pixel appearance. Settings reuse the existing image-crop dialog. Clients treat the field as optional for compatibility with older servers. Images retain live status and presence indicators. Native mobile has its own image renderer with authenticated requests.

## Compatibility and rollback

The nullable column is additive; older releases ignore it and continue to draw the existing pixel appearance. Rollback can keep the column in place. The existing DELETE avatar API clears the reference and returns to the preserved appearance. Restoring a previous portrait re-uploads its saved original file. Name changes use the existing agent PATCH API, whose previous handles retain old mentions; no conversation bodies are rewritten.

## Verification

Focused engine and HTTP tests cover persistent upload/read/remove, original PNG bytes, field preservation, owner and tenant boundaries, the built-in right hand, invalid images, different agents with identical content and a twelve-agent import. Web tests cover render/fallback and settings; runtime verification must confirm the deployed image and a restart.
