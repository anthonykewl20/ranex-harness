import { AgentV2 } from "@ranex/core/agent"
import { AISDK } from "@ranex/core/aisdk"
import { Catalog } from "@ranex/core/catalog"
import { CommandV2 } from "@ranex/core/command"
import { Credential } from "@ranex/core/credential"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { FileSystem } from "@ranex/core/filesystem"
import { FSUtil } from "@ranex/core/fs-util"
import { Integration } from "@ranex/core/integration"
import { Location } from "@ranex/core/location"
import { Npm } from "@ranex/core/npm"
import { PluginV2 } from "@ranex/core/plugin"
import { Reference } from "@ranex/core/reference"
import { SkillV2 } from "@ranex/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
