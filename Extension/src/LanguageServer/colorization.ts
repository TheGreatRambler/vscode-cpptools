/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as util from '../common';
import { CppSettings, OtherSettings, TextMateRule, TextMateRuleSettings, TextMateContributesGrammar } from './settings';
import * as jsonc from 'jsonc-parser';
import * as plist from 'plist';

export enum TokenKind {
    // These need to match the token_kind enum in the server

    // Syntactic/Lexical tokens
    Identifier,
    Comment,
    Keyword,
    PreprocessorKeyword,
    Operator,
    Variable,
    NumberLiteral,
    StringLiteral,
    XmlDocComment,
    XmlDocTag,

    // Semantic tokens
    Macro,
    Enumerator,
    GlobalVariable,
    LocalVariable,
    Parameter,
    Type,
    RefType,
    ValueType,
    Function,
    MemberFunction,
    MemberField,
    StaticMemberFunction,
    StaticMemberField,
    Property,
    Event,
    ClassTemplate,
    GenericType,
    FunctionTemplate,
    Namespace,
    Label,
    UdlRaw,
    UdlNumber,
    UdlString,
    OperatorFunction,
    MemberOperator,
    NewDelete,

    Count
}

interface VersionedEdits {
    editVersion: number;
    changes: vscode.TextDocumentContentChangeEvent[];
}

class ThemeStyle {
    foreground: string;
    background: string;
    fontStyle: string;
}

export class ColorizationSettings {
    private uri: vscode.Uri;
    private pendingTask: util.BlockingTask<any>;
    private editorBackground: string;

    public themeStyleCMap: ThemeStyle[] = [];
    public themeStyleCppMap: ThemeStyle[] = [];

    private static readonly scopeToTokenColorNameMap = new Map<string, string>([
        ["comment", "comments"],
        ["string", "strings"],
        ["keyword.operator", "keywords"],
        ["keyword.control", "keywords"],
        ["constant.numeric", "numbers"],
        ["entity.name.type", "types"],
        ["entity.name.class", "types"],
        ["entity.name.function", "functions"],
        ["variable", "variables"]
    ]);

    constructor(uri: vscode.Uri) {
        this.uri = uri;
        this.updateGrammars();
        this.reload();
    }

    // Given a TextMate rule 'settings' mode, update a ThemeStyle to include any color or style information
    private updateStyleFromTextMateRuleSettings(baseStyle: ThemeStyle, textMateRuleSettings: TextMateRuleSettings): void {
        if (textMateRuleSettings.foreground) {
            baseStyle.foreground = textMateRuleSettings.foreground;
        }
        if (textMateRuleSettings.background && textMateRuleSettings.background !== this.editorBackground) {
            baseStyle.background = textMateRuleSettings.background;
        }
        // Any (even empty) string for fontStyle removes inherited value
        if (textMateRuleSettings.fontStyle) {
            baseStyle.fontStyle = textMateRuleSettings.fontStyle;
        } else if (textMateRuleSettings.fontStyle === "") {
            baseStyle.fontStyle = undefined;
        }
    }

    // If the scope can be found in a set of TextMate rules, apply it to both C and Cpp ThemeStyle's
    private findThemeStyleForScope(baseCStyle: ThemeStyle, baseCppStyle: ThemeStyle, scope: string, textMateRules: TextMateRule[]): void {
        if (textMateRules) {
            let match: TextMateRule = textMateRules.find(e => e.settings && (e.scope === scope || ((e.scope instanceof Array) && e.scope.indexOf(scope) > -1)));
            if (match) {
                if (baseCStyle) {
                    this.updateStyleFromTextMateRuleSettings(baseCStyle, match.settings);
                }
                if (baseCppStyle) {
                    this.updateStyleFromTextMateRuleSettings(baseCppStyle, match.settings);
                }
            }
        }
    }

    // For a specific scope cascase all potential sources of style information to create a final ThemeStyle
    private calculateThemeStyleForScope(baseCStyle: ThemeStyle, baseCppStyle: ThemeStyle, scope: string, themeName: string, themeTextMateRules: TextMateRule[][]): void {
        // Search for settings with this scope in current theme
        themeTextMateRules.forEach((rules) => {
            this.findThemeStyleForScope(baseCStyle, baseCppStyle, scope, rules);
        });

        let otherSettings: OtherSettings = new OtherSettings(this.uri);

        // Next in priority would be a global user override of token color of the equivilent scope
        let colorTokenName: string | undefined = ColorizationSettings.scopeToTokenColorNameMap.get(scope);
        if (colorTokenName) {
            let settingValue: string = otherSettings.getCustomColorToken(colorTokenName);
            if (settingValue) {
                if (baseCStyle) {
                    baseCStyle.foreground = settingValue;
                }
                if (baseCppStyle) {
                    baseCppStyle.foreground = settingValue;
                }
            }
        }

        // Next in priority would be a global user override of this scope in textMateRules
        this.findThemeStyleForScope(baseCStyle, baseCppStyle, scope, otherSettings.customTextMateRules);

        // Next in priority would be a theme-specific user override of token color of the equivilent scope
        if (colorTokenName) {
            let settingValue: string = otherSettings.getCustomThemeSpecificColorToken(colorTokenName, themeName);
            if (settingValue) {
                if (baseCStyle) {
                    baseCStyle.foreground = settingValue;
                }
                if (baseCppStyle) {
                    baseCppStyle.foreground = settingValue;
                }
            }
        }

        // Next in priority would be a theme-specific user override of this scope in textMateRules
        let textMateRules: TextMateRule[] = otherSettings.getCustomThemeSpecificTextMateRules(themeName);
        this.findThemeStyleForScope(baseCStyle, baseCppStyle, scope, textMateRules);
    }

    // For each level of the scope, look of style information
    private calculateStyleForToken(tokenKind: TokenKind, scope: string, themeName: string, themeTextMateRules: TextMateRule[][]): void {
        // Try scopes, from most general to most specific, apply style in cascading manner
        let parts: string[] = scope.split(".");
        let accumulatedScope: string = "";
        for (let i: number = 0; i < parts.length; i++) {
            accumulatedScope += parts[i];
            this.calculateThemeStyleForScope(this.themeStyleCMap[tokenKind], this.themeStyleCppMap[tokenKind], accumulatedScope, themeName, themeTextMateRules);
            this.calculateThemeStyleForScope(this.themeStyleCMap[tokenKind], null, accumulatedScope + ".c", themeName, themeTextMateRules);
            this.calculateThemeStyleForScope(null, this.themeStyleCppMap[tokenKind], accumulatedScope + ".cpp", themeName, themeTextMateRules);
            accumulatedScope += ".";
        }
    }

    public syncWithLoadingSettings(f: () => any): void {
        this.pendingTask = new util.BlockingTask<void>(f, this.pendingTask);
    }

    public updateStyles(themeName: string, defaultStyle: ThemeStyle, textMateRules: TextMateRule[][]): void {
        this.themeStyleCMap = new Array<ThemeStyle>(TokenKind.Count);
        this.themeStyleCppMap = new Array<ThemeStyle>(TokenKind.Count);

        // Populate with unique objects, as they will be individual modified in place
        for (let i: number = 0; i < TokenKind.Count; i++) {
            this.themeStyleCMap[i] = Object.assign({}, defaultStyle);
            this.themeStyleCppMap[i] = Object.assign({}, defaultStyle);
        }

        this.calculateStyleForToken(TokenKind.Identifier, "entity.name", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Comment, "comment", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Keyword, "keyword.control", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.PreprocessorKeyword, "keyword.control.directive", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Operator, "keyword.operator", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Variable, "variable", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.NumberLiteral, "constant.numeric", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.StringLiteral, "string.quoted", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.XmlDocComment, "comment.xml.doc", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.XmlDocTag, "comment.xml.doc.tag", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Macro, "entity.name.function.preprocessor", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Enumerator, "variable.other.enummember", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.GlobalVariable, "variable.other.global", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.LocalVariable, "variable.other.local", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Parameter, "variable.parameter", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Type, "entity.name.type", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.RefType, "entity.name.class.reference", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.ValueType, "entity.name.class.value", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Function, "entity.name.function", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.MemberFunction, "entity.name.function.member", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.MemberField, "variable.other.member", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.StaticMemberFunction, "entity.name.function.member.static", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.StaticMemberField, "variable.other.member.static", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Property, "variable.other.property", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Event, "variable.other.event", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.ClassTemplate, "entity.name.class.template", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.GenericType, "entity.name.class.generic", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.FunctionTemplate, "entity.name.function.template", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Namespace, "entity.name.namespace", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.Label, "entity.name.label", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.UdlRaw, "entity.name.user-defined-literal", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.UdlNumber, "entity.name.user-defined-literal.number", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.UdlString, "entity.name.user-defined-literal.string", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.OperatorFunction, "entity.name.function.operator", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.MemberOperator, "keyword.operator.member", themeName, textMateRules);
        this.calculateStyleForToken(TokenKind.NewDelete, "keyword.operator.new", themeName, textMateRules);
    }

    public async loadTheme(themePath: string, defaultStyle: ThemeStyle): Promise<TextMateRule[][]> {
        let rules: TextMateRule[][] = [];
        if (await util.checkFileExists(themePath)) {
            let themeContentText: string = await util.readFileText(themePath);
            let themeContent: any;
            let textMateRules: TextMateRule[];
            if (themePath.endsWith("tmTheme")) {
                themeContent = plist.parse(themeContentText);
                if (themeContent) {
                    textMateRules = themeContent.settings;

                    // Convert comma delimited scopes into an array, to match the json format
                    textMateRules.forEach(e => {
                        if (e.scope && e.scope.includes(',')) {
                            e.scope = e.scope.split(',').map((s: string) => s.trim());
                        }
                    });
                }
            } else {
                themeContent = jsonc.parse(themeContentText);
                if (themeContent) {
                    textMateRules = themeContent.tokenColors;
                    if (themeContent.include) {
                        // parse included theme file
                        let includedThemePath: string = path.join(path.dirname(themePath), themeContent.include);
                        rules = await this.loadTheme(includedThemePath, defaultStyle);
                    }

                    if (themeContent.colors && themeContent.colors["editor.background"]) {
                        this.editorBackground = themeContent.colors["editor.background"];
                    }
                }
            }

            if (textMateRules) {
                let scopelessSetting: any = textMateRules.find(e => e.settings && !e.scope);
                if (scopelessSetting) {
                    if (scopelessSetting.settings.background) {
                        this.editorBackground = scopelessSetting.settings.background;
                    }
                    this.updateStyleFromTextMateRuleSettings(defaultStyle, scopelessSetting.settings);
                }
                rules.push(textMateRules);
            }
        }

        return rules;
    }

    public reload(): void {
        let f: () => void = async () => {
            let otherSettings: OtherSettings = new OtherSettings(this.uri);
            let themeName: string = otherSettings.colorTheme;

            // Enumerate through all extensions, looking for this theme.  (Themes are implemented as extensions - even the default ones)
            // Open each package.json to check for a theme path
            for (let i: number = 0; i < vscode.extensions.all.length; i++) {
                let extensionPath: string = vscode.extensions.all[i].extensionPath;
                let extensionPackageJsonPath: string = path.join(extensionPath, "package.json");
                if (!await util.checkFileExists(extensionPackageJsonPath)) {
                    continue;
                }
                let packageJsonText: string = await util.readFileText(extensionPackageJsonPath);
                let packageJson: any = jsonc.parse(packageJsonText);
                if (packageJson.contributes && packageJson.contributes.themes) {
                    let foundTheme: any = packageJson.contributes.themes.find(e => e.id === themeName || e.label === themeName);
                    if (foundTheme) {
                        let themeRelativePath: string = foundTheme.path;
                        let themeFullPath: string = path.join(extensionPath, themeRelativePath);
                        let defaultStyle: ThemeStyle = new ThemeStyle();
                        let rulesSet: TextMateRule[][] = await this.loadTheme(themeFullPath, defaultStyle);
                        this.updateStyles(themeName, defaultStyle, rulesSet);
                        return;
                    }
                }
            }
        };
        this.syncWithLoadingSettings(f);
    }

    public static createDecorationFromThemeStyle(themeStyle: ThemeStyle): vscode.TextEditorDecorationType {
        if (themeStyle && (themeStyle.foreground || themeStyle.background || themeStyle.fontStyle)) {
            let options: vscode.DecorationRenderOptions = {};
            options.rangeBehavior = vscode.DecorationRangeBehavior.OpenOpen;
            if (themeStyle.foreground) {
                options.color = themeStyle.foreground;
            }
            if (themeStyle.background) {
                options.backgroundColor = themeStyle.background;
            }
            if (themeStyle.fontStyle) {
                let parts: string[] = themeStyle.fontStyle.split(" ");
                parts.forEach((part) => {
                    switch (part) {
                        case "italic":
                            options.fontStyle = "italic";
                            break;
                        case "bold":
                            options.fontWeight = "bold";
                            break;
                        case "underline":
                            options.textDecoration = "underline";
                            break;
                        default:
                            break;
                    }
                });
            }
            return vscode.window.createTextEditorDecorationType(options);
        }

        return null;
    }

    public useEmptyGrammars(): void {
        let packageJson: any = util.getRawPackageJson();
        if (!packageJson.contributes.grammars || !packageJson.contributes.grammars.length) {
            let cppGrammarContributesNode: TextMateContributesGrammar = {
                language: "cpp",
                scopeName: "source.cpp",
                path: "./nogrammar.cpp.json"
            };
            let cGrammarContributesNode: TextMateContributesGrammar = {
                language: "c",
                scopeName: "source.c",
                path: "./nogrammar.c.json"
            };
            packageJson.contributes.grammars = [];
            packageJson.contributes.grammars.push(cppGrammarContributesNode);
            packageJson.contributes.grammars.push(cGrammarContributesNode);
            util.writeFileText(util.getPackageJsonPath(), util.stringifyPackageJson(packageJson));
            util.promptForReloadWindowDueToSettingsChange();
        }
    }

    public useStandardGrammars(): void {
        let packageJson: any = util.getRawPackageJson();
        if (packageJson.contributes.grammars && packageJson.contributes.grammars.length > 0) {
            packageJson.contributes.grammars = [];
            util.writeFileText(util.getPackageJsonPath(), util.stringifyPackageJson(packageJson));
            util.promptForReloadWindowDueToSettingsChange();
        }
    }

    public updateGrammars(): void {
        let settings: CppSettings = new CppSettings(this.uri);
        if (settings.textMateColorization === "Disabled") {
            this.useEmptyGrammars();
        } else {
            this.useStandardGrammars();
        }
    }
}

export class ColorizationState {
    private uri: vscode.Uri;
    private colorizationSettings: ColorizationSettings;
    private decorations: vscode.TextEditorDecorationType[] = new Array<vscode.TextEditorDecorationType>(TokenKind.Count);
    private syntacticRanges: vscode.Range[][] = new Array<vscode.Range[]>(TokenKind.Count);
    private semanticRanges: vscode.Range[][] = new Array<vscode.Range[]>(TokenKind.Count);
    private inactiveDecoration: vscode.TextEditorDecorationType = null;
    private inactiveRanges: vscode.Range[] = [];
    private versionedEdits: VersionedEdits[] = [];
    private currentSyntacticVersion: number = 0;
    private lastReceivedSyntacticVersion: number = 0;
    private currentSemanticVersion: number = 0;
    private lastReceivedSemanticVersion: number = 0;

    public constructor(uri: vscode.Uri, colorizationSettings: ColorizationSettings) {
        this.uri = uri;
        this.colorizationSettings = colorizationSettings;
    }

    private createColorizationDecorations(isCpp: boolean): void {
        let settings: CppSettings = new CppSettings(this.uri);
        if (settings.enhancedColorization === "Enabled" && settings.intelliSenseEngine === "Default") {
            // Create new decorators
            // The first decorator created takes precedence, so these need to be created in reverse order
            for (let i: number = TokenKind.Count; i > 0;) {
                i--;
                let themeStyleMap: any;
                if (isCpp) {
                    themeStyleMap = this.colorizationSettings.themeStyleCppMap;
                } else {
                    themeStyleMap = this.colorizationSettings.themeStyleCMap;
                }
                this.decorations[i] = ColorizationSettings.createDecorationFromThemeStyle(themeStyleMap[i]);
            }
        }
        if (settings.dimInactiveRegions) {
            this.inactiveDecoration = vscode.window.createTextEditorDecorationType({
                opacity: settings.inactiveRegionOpacity.toString(),
                backgroundColor: settings.inactiveRegionBackgroundColor,
                color: settings.inactiveRegionForegroundColor,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
            });
        }
    }

    private disposeColorizationDecorations(): void {
        // Dispose of all old decorations
        if (this.inactiveDecoration) {
            this.inactiveDecoration.dispose();
            this.inactiveDecoration = null;
        }
        for (let i: number = 0; i < TokenKind.Count; i++) {
            if (this.decorations[i]) {
                this.decorations[i].dispose();
                this.decorations[i] = null;
            }
        }
    }

    public dispose(): void {
        this.disposeColorizationDecorations();
    }

    private refreshInner(e: vscode.TextEditor): void {
        let settings: CppSettings = new CppSettings(this.uri);
        if (settings.enhancedColorization === "Enabled" && settings.intelliSenseEngine === "Default") {
            for (let i: number = 0; i < TokenKind.Count; i++) {
                if (this.decorations[i]) {
                    let ranges: vscode.Range[] = this.syntacticRanges[i];
                    if (this.semanticRanges[i]) {
                        if (!ranges || !ranges.length) {
                            ranges = this.semanticRanges[i];
                        } else {
                            ranges = ranges.concat(this.semanticRanges[i]);
                        }
                    }
                    if (ranges && ranges.length > 0) {
                        e.setDecorations(this.decorations[i], ranges);
                    }
                }
            }
        }

        // Normally, decorators are honored in the order in which they were created, not the 
        // order in which they were applied.  Decorators with opacity appear to be handled
        // differently, in that the opacity is applied to overlapping decorators even if
        // created afterwards.
        if (settings.dimInactiveRegions && this.inactiveDecoration && this.inactiveRanges) {
            e.setDecorations(this.inactiveDecoration, this.inactiveRanges);
        }
    }

    public refresh(e: vscode.TextEditor): void {
        this.applyEdits();
        let f: () => void = async () => {
            this.refreshInner(e);
        };
        this.colorizationSettings.syncWithLoadingSettings(f);
    }

    public onSettingsChanged(uri: vscode.Uri): void {
        let f: () => void = async () => {
            this.applyEdits();
            this.disposeColorizationDecorations();
            let isCpp: boolean = util.isEditorFileCpp(uri.toString());
            this.createColorizationDecorations(isCpp);
            let editors: vscode.TextEditor[] = vscode.window.visibleTextEditors.filter(e => e.document.uri === uri);
            for (let e of editors) {
                this.refreshInner(e);
            }
        };
        this.colorizationSettings.syncWithLoadingSettings(f);
    }

    // Utility function to convert a string and a start Position into a Range
    private textToRange(text: string, startPosition: vscode.Position): vscode.Range {
        let parts: string[] = text.split("\n");
        let addedLines: number = parts.length - 1;
        let newStartLine: number = startPosition.line;
        let newStartCharacter: number = startPosition.character;
        let newEndLine: number = newStartLine + addedLines;
        let newEndCharacter: number = parts[parts.length - 1].length;
        if (newStartLine === newEndLine) {
            newEndCharacter += newStartCharacter;
        }
        return new vscode.Range(newStartLine, newStartCharacter, newEndLine, newEndCharacter);
    }

    // Utility function to shift a range back after removing content before it
    private shiftRangeAfterRemove(range: vscode.Range, removeStartPosition: vscode.Position, removeEndPosition: vscode.Position): vscode.Range {
        let lineDelta: number = removeStartPosition.line - removeEndPosition.line;
        let startCharacterDelta: number = 0;
        let endCharacterDelta: number = 0;
        if (range.start.line === removeEndPosition.line) {
            startCharacterDelta = removeStartPosition.character - removeEndPosition.character;
            if (range.end.line === removeEndPosition.line) {
                endCharacterDelta = startCharacterDelta;
            }
        }
        let newStart: vscode.Position = range.start.translate(lineDelta, startCharacterDelta);
        let newEnd: vscode.Position = range.end.translate(lineDelta, endCharacterDelta);
        return new vscode.Range(newStart, newEnd);
    }

    // Utility function to shift a range forward after inserting content before it
    private shiftRangeAfterInsert(range: vscode.Range, insertStartPosition: vscode.Position, insertEndPosition: vscode.Position): vscode.Range {
        let addedLines: number = insertEndPosition.line - insertStartPosition.line;
        let newStartLine: number = range.start.line + addedLines;
        let newEndLine: number = range.end.line + addedLines;
        let newStartCharacter: number = range.start.character;
        let newEndCharacter: number = range.end.character;
        // If starts on the same line as replacement ended
        if (insertEndPosition.line === newStartLine) {
            let endOffsetLength: number = insertEndPosition.character;
            // If insertRange starts and ends on the same line, only offset by it's length
            if (insertEndPosition.line === insertStartPosition.line) {
                endOffsetLength -= insertStartPosition.character;
            }
            newStartCharacter += endOffsetLength;
            if (insertEndPosition.line === newEndLine) {
                newEndCharacter += endOffsetLength;
            }
        }
        return new vscode.Range(newStartLine, newStartCharacter, newEndLine, newEndCharacter);
    }

    // Utility function to adjust a range to account for an insert and/or replace
    private fixRange(range: vscode.Range, removeInsertStartPosition: vscode.Position, removeEndPosition: vscode.Position, insertEndPosition: vscode.Position): vscode.Range {
        // If the replace/insert starts after this range ends, no adjustment is needed.
        if (removeInsertStartPosition.isAfterOrEqual(range.end)) {
            return range;
        }
        // Else, replace/insert range starts before this range ends.

        // If replace/insert starts before/where this range starts, we don't need to extend the existing range, but need to shift it
        if (removeInsertStartPosition.isBeforeOrEqual(range.start)) {

            // If replace consumes the entire range, remove it
            if (removeEndPosition.isAfterOrEqual(range.end)) {
                return null;
            }

            // If replace ends within this range, we need to trim it before we shift it
            let newRange: vscode.Range;
            if (removeEndPosition.isAfterOrEqual(range.start)) {
                newRange = new vscode.Range(removeEndPosition, range.end);
            } else {
                newRange = range;
            }
            // Else, if replace ends before this range starts, we just need to shift it.

            newRange = this.shiftRangeAfterRemove(newRange, removeInsertStartPosition, removeEndPosition);
            return this.shiftRangeAfterInsert(newRange, removeInsertStartPosition, insertEndPosition);
        }
        // Else, if replace/insert starts within (not before or after) range, extend it.

        // If there replace/insert overlaps past the end of the original range, just extend existing range to the insert end position
        if (removeEndPosition.isAfterOrEqual(range.end)) {
            return new vscode.Range(range.start.line, range.start.character, insertEndPosition.line, insertEndPosition.character);
        }
        // Else, range has some left over at the end, which needs to be shifted after insertEndPosition.

        // If the trailing segment is on the last line replace, we just need to extend by the remaining number of characters
        if (removeEndPosition.line === range.end.line) {
            return new vscode.Range(range.start.line, range.start.character, insertEndPosition.line, insertEndPosition.character + (range.end.character - removeEndPosition.character));
        }
        // Else, the trailing segment ends on another line, so the character position should remain the same.  Just adjust based on added/removed lined.
        let removedLines: number = removeEndPosition.line - removeInsertStartPosition.line;
        let addedLines: number = insertEndPosition.line - removeInsertStartPosition.line;
        let deltaLines: number = addedLines - removedLines;
        return new vscode.Range(range.start.line, range.start.character, range.end.line + deltaLines,  range.end.character);
    }

    private fixRanges(originalRanges: vscode.Range[], changes: vscode.TextDocumentContentChangeEvent[]): vscode.Range[] {
        // outer loop needs to be the versioned edits, then changes within that edit, then ranges
        let ranges: vscode.Range[] = originalRanges;
        if (ranges && ranges.length > 0) {
            changes.forEach((change) => {
                let newRanges: vscode.Range[] = [];
                let insertRange: vscode.Range = this.textToRange(change.text, change.range.start);
                for (let i: number = 0; i < ranges.length; i++) {
                    let newRange: vscode.Range = this.fixRange(ranges[i], change.range.start, change.range.end, insertRange.end);
                    if (newRange !== null) {
                        newRanges.push(newRange);
                    }
                }
                ranges = newRanges;
            });
        }
        return ranges;
    }

    // Add edits to be applied when/if cached tokens need to be reapplied.
    public addEdits(changes: vscode.TextDocumentContentChangeEvent[], editVersion: number): void {
        let edits: VersionedEdits = {
            editVersion: editVersion,
            changes: changes
        };
        this.versionedEdits.push(edits);
    }

    // Apply any pending edits to the currently cached tokens
    private applyEdits() : void {
        this.versionedEdits.forEach((edit) => {
            if (edit.editVersion > this.currentSyntacticVersion) {
                for (let i: number = 0; i < TokenKind.Count; i++) {
                    this.syntacticRanges[i] = this.fixRanges(this.syntacticRanges[i], edit.changes);
                }
                this.currentSyntacticVersion = edit.editVersion;
            }
            if (edit.editVersion > this.currentSemanticVersion) {
                for (let i: number = 0; i < TokenKind.Count; i++) {
                    this.semanticRanges[i] = this.fixRanges(this.semanticRanges[i], edit.changes);
                }
                this.inactiveRanges = this.fixRanges(this.inactiveRanges, edit.changes);
                this.currentSemanticVersion = edit.editVersion;
            }
        });
    }

    // Remove any edits from the list if we will never receive tokens that old.
    private purgeOldVersionedEdits(): void {
        let minVersion: number = Math.min(this.lastReceivedSemanticVersion, this.lastReceivedSyntacticVersion);
        let index: number = this.versionedEdits.findIndex((edit) => edit.editVersion > minVersion);
        if (index === -1) {
            this.versionedEdits = [];
        } else if (index > 0) {
            this.versionedEdits = this.versionedEdits.slice(index);
        }
    }

    private updateColorizationRanges(uri: string): void {
        let f: () => void = async () => {
            this.applyEdits();
            this.purgeOldVersionedEdits();

            // The only way to un-apply decorators is to dispose them.
            // If we dispose old decorators before applying new decorators, we see a flicker on Mac,
            // likely due to a race with UI updates.  Here we set aside the existing decorators to be
            // disposed of after the new decorators have been applied, so there is not a gap
            // in which decorators are not applied.
            let oldInactiveDecoration: vscode.TextEditorDecorationType = this.inactiveDecoration;
            let oldDecorations: vscode.TextEditorDecorationType[] = this.decorations;
            this.inactiveDecoration = null;
            this.decorations =  new Array<vscode.TextEditorDecorationType>(TokenKind.Count);

            let isCpp: boolean = util.isEditorFileCpp(uri);
            this.createColorizationDecorations(isCpp);

            // Apply the decorations to all *visible* text editors
            let editors: vscode.TextEditor[] = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === uri);
            for (let e of editors) {
                this.refreshInner(e);
            }

            // Dispose of the old decorators only after the new ones have been applied.
            if (oldInactiveDecoration) {
                oldInactiveDecoration.dispose();
            }
            if (oldDecorations) {
                for (let i: number = 0; i < TokenKind.Count; i++) {
                    if (oldDecorations[i]) {
                        oldDecorations[i].dispose();
                    }
                }
            }
        };
        this.colorizationSettings.syncWithLoadingSettings(f);
    }

    public updateSyntactic(uri: string, syntacticRanges: vscode.Range[][], editVersion: number): void {
        for (let i: number = 0; i < TokenKind.Count; i++) {
            this.syntacticRanges[i] = syntacticRanges[i];
        }
        this.currentSyntacticVersion = editVersion;
        this.lastReceivedSyntacticVersion = editVersion;
        this.updateColorizationRanges(uri);
    }

    public updateSemantic(uri: string, semanticRanges: vscode.Range[][], inactiveRanges: vscode.Range[], editVersion: number): void {
       this.inactiveRanges = inactiveRanges;
        for (let i: number = 0; i < TokenKind.Count; i++) {
            this.semanticRanges[i] = semanticRanges[i];
        }
        this.currentSemanticVersion = editVersion;
        this.lastReceivedSemanticVersion = editVersion;
        this.updateColorizationRanges(uri);
    }
}
