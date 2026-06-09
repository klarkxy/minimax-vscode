// Proposed `languageModelChatProvider.configurationSchema` API.
//
// Copied from VS Code repository
// (src/vscode-dts/vscode.proposed.languageModelConfigurationSchema.d.ts).
// The shape mirrors what GitHub Copilot Chat consumes when rendering
// the per-model configuration dropdown in the model picker (e.g.
// the `reasoningEffort` dropdown for `deepseek-v4-for-copilot`).
// We expose the same shape here so our `toChatInfo` can attach the
// thinking on/off dropdown that the picker renders beneath the
// model name.
//
// To update: npx @vscode/dts dev
// Can be removed once the API graduates to stable.

declare module "vscode" {
  /**
   * Schema for a model picker's per-model configuration. Copilot
   * Chat renders one dropdown per declared `properties` entry; the
   * user's selection is then delivered on the next chat request as
   * `options.modelConfiguration[key]`.
   */
  export interface LanguageModelConfigurationSchema {
    /**
     * Map of property name to its descriptor. Each entry becomes a
     * row in the picker's per-model configuration section.
     */
    readonly properties?: Record<
      string,
      LanguageModelConfigurationPropertySchema
    >;
  }

  /**
   * Descriptor for a single property on a model's
   * `LanguageModelConfigurationSchema`.
   */
  export interface LanguageModelConfigurationPropertySchema {
    /**
     * The type of the value. Copilot Chat renders a dropdown for
     * `string`-typed enums, a numeric input for `number`, and a
     * checkbox for `boolean`.
     */
    readonly type: "string" | "number" | "boolean";

    /**
     * Short label rendered next to the control in the picker.
     */
    readonly title: string;

    /**
     * Allowed values (string enums). Rendered as a dropdown when
     * the property type is `string`.
     */
    readonly enum?: readonly string[];

    /**
     * Human-readable labels for the values in `enum`. Must have the
     * same length as `enum` if provided.
     */
    readonly enumItemLabels?: readonly string[];

    /**
     * Tooltip / help text for each `enum` value. Must have the
     * same length as `enum` if provided.
     */
    readonly enumDescriptions?: readonly string[];

    /**
     * Default value, applied by the host on every re-render. Pick
     * the value you want to ship with; the user's selection is
     * persisted separately in `options.modelConfiguration`.
     */
    readonly default?: string | number | boolean;

    /**
     * Optional grouping label; the picker renders properties with
     * the same `group` next to each other.
     */
    readonly group?: string;
  }

  export interface LanguageModelChatInformation {
    /**
     * Optional per-model configuration schema. The host renders one
     * control per declared property and passes the user's selection
     * back on the next `provideLanguageModelChatResponse` call.
     */
    readonly configurationSchema?: LanguageModelConfigurationSchema;
  }
}
