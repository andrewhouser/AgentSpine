import SwiftUI

/// Settings → Recipes: the named recipes you approved in chat, editable in place.
///
/// A recipe is text a future run follows, so every word of it is readable here and can be changed
/// without going back to the chat. There is no "new recipe": one is created by `recipe_save` in a
/// conversation, where its whole text goes through the approval card. Editing or deleting one
/// here is a person at the screen, which is the same trust (the web client works the same way).
struct RecipesView: View {
    @State private var recipes: [Recipe] = []
    @State private var loading = false
    @State private var error: String?
    @State private var deleting: Recipe?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            Section {
                ForEach(recipes) { recipe in
                    NavigationLink(value: recipe) { RecipeRow(recipe: recipe) }
                        .swipeActions {
                            Button("Delete", role: .destructive) { deleting = recipe }
                        }
                        .contextMenu {
                            Button("Delete", role: .destructive) { deleting = recipe }
                        }
                }
            } footer: {
                Text("In a chat, say “save this as a recipe” and approve the card. After that, “run pi-brief” "
                     + "(or “/pi-brief”) puts the steps in front of the assistant. Nothing prunes these.")
            }
            if recipes.isEmpty && !loading && error == nil {
                Text("No saved recipes yet.").foregroundStyle(Spine.Palette.textDim)
            }
        }
        .navigationTitle("Recipes")
        .spineInlineTitle()
        .navigationDestination(for: Recipe.self) { recipe in
            RecipeEditView(recipe: recipe) { saved in
                if let i = recipes.firstIndex(where: { $0.id == saved.id }) { recipes[i] = saved }
            } onDeleted: {
                recipes.removeAll { $0.id == recipe.id }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && recipes.isEmpty { ProgressView() } }
        .confirmationDialog(
            "Delete the recipe “\(deleting?.name ?? "")”?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete recipe", role: .destructive) {
                if let recipe = deleting { Task { await delete(recipe) } }
            }
        } message: {
            Text("Asking for it by name will stop working.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            recipes = try await APIClient.shared.recipes()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ recipe: Recipe) async {
        do {
            try await APIClient.shared.deleteRecipe(recipe.id)
            recipes.removeAll { $0.id == recipe.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct RecipeRow: View {
    let recipe: Recipe

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(recipe.name).font(SpineFont.mono(Spine.TypeSize.body, relativeTo: .body))
            Text(recipe.whenText)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
            Text("\(recipe.steps.count) step\(recipe.steps.count == 1 ? "" : "s") · used \(recipe.uses)×"
                 + (recipe.lastUsed.map { " · last \(SpineDate.relative($0))" } ?? ""))
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One recipe as a form. Steps edit as one per line; the server validates the whole recipe and
/// its message is shown as it comes, so the rules (step count, name clashes) live in one place.
struct RecipeEditView: View {
    let recipe: Recipe
    var onSaved: (Recipe) -> Void
    var onDeleted: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var whenText: String
    @State private var steps: String
    @State private var saving = false
    @State private var confirmDelete = false
    @State private var error: String?

    init(recipe: Recipe, onSaved: @escaping (Recipe) -> Void, onDeleted: @escaping () -> Void) {
        self.recipe = recipe
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _name = State(initialValue: recipe.name)
        _whenText = State(initialValue: recipe.whenText)
        _steps = State(initialValue: recipe.steps.joined(separator: "\n"))
    }

    private var stepList: [String] {
        steps.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private var canSave: Bool {
        !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !whenText.trimmingCharacters(in: .whitespaces).isEmpty && !stepList.isEmpty
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("Name", text: $name)
                    .spineNoAutocapitalization()
                    .autocorrectionDisabled()
            }
            Section("When to use it") {
                TextField("When to use it", text: $whenText, axis: .vertical)
            }
            Section {
                TextEditor(text: $steps)
                    .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .frame(minHeight: 140)
                    .accessibilityLabel("Steps, one per line")
            } header: {
                Text("Steps, one per line")
            }
            if let error {
                Section { Text(error).foregroundStyle(Spine.Palette.danger) }
            }
            Section {
                Button("Save") { Task { await save() } }
                    .disabled(!canSave)
                Button("Delete recipe", role: .destructive) { confirmDelete = true }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(recipe.name)
        .spineInlineTitle()
        .confirmationDialog("Delete the recipe “\(recipe.name)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete recipe", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Asking for it by name will stop working.")
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let saved = try await APIClient.shared.updateRecipe(
                recipe.id,
                name: name.trimmingCharacters(in: .whitespaces),
                whenText: whenText.trimmingCharacters(in: .whitespaces),
                steps: stepList
            )
            onSaved(saved)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete() async {
        do {
            try await APIClient.shared.deleteRecipe(recipe.id)
            onDeleted()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Styles
//
// Lives in this file only because it is already part of both Xcode targets; a new file would need a project
// edit. It is a sibling of Recipes: standing text a person approves.

/// Settings → Styles: how you write to different recipients, learned from your sent mail.
///
/// The assistant can only propose a style: it builds one locally and never shows the note to the chat. You read
/// the whole note here and press Accept, which no tool can do. Code picks the style for a draft (an exact address,
/// then a domain, then the default); the model never chooses.
struct StylesView: View {
    @State private var state: StylesState?
    @State private var loading = false
    @State private var error: String?
    @State private var deleting: WritingStyle?

    private func rule(_ a: StyleAppliesTo) -> String {
        let parts = a.addresses + a.domains.map { "@\($0)" }
        return parts.isEmpty ? "No rule: used only as the default, or when you name it" : "Applies to \(parts.joined(separator: ", "))"
    }

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let state {
                ForEach(state.proposals) { p in
                    Section {
                        if p.replaces {
                            Text("Accepting this REPLACES the style “\(p.name)” you have now.")
                                .foregroundStyle(Spine.Palette.danger)
                        }
                        Text(p.note)
                        Text("\(rule(p.appliesTo)) · built from \(p.sampled) sent messages")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                        Button("Accept") { Task { await act { try await APIClient.shared.acceptStyleProposal(p.name) } } }
                        Button("Discard", role: .destructive) { Task { await act { try await APIClient.shared.rejectStyleProposal(p.name) } } }
                    } header: {
                        Text("Waiting: \(p.name)")
                    }
                }
                if !state.styles.isEmpty {
                    Section {
                        Picker("Default", selection: Binding(
                            get: { state.styles.contains { $0.name == state.defaultStyle } ? state.defaultStyle : "" },
                            set: { name in Task { await act { try await APIClient.shared.setDefaultStyle(name) } } }
                        )) {
                            if !state.styles.contains(where: { $0.name == state.defaultStyle }) {
                                Text("\(state.defaultStyle) (not saved yet)").tag("")
                            }
                            ForEach(state.styles) { Text($0.name).tag($0.name) }
                        }
                    } footer: {
                        Text("Used when no address or domain rule matches the recipient.")
                    }
                }
                Section {
                    ForEach(state.styles) { style in
                        NavigationLink(value: style) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(style.name + (style.name == state.defaultStyle ? " (default)" : ""))
                                    .font(SpineFont.mono(Spine.TypeSize.body, relativeTo: .body))
                                Text(style.note).lineLimit(3)
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                    .foregroundStyle(Spine.Palette.textDim)
                                Text(rule(style.appliesTo))
                                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textFaint)
                            }
                        }
                        .swipeActions { Button("Delete", role: .destructive) { deleting = style } }
                        .contextMenu { Button("Delete", role: .destructive) { deleting = style } }
                    }
                } footer: {
                    Text("In a chat, say “learn my casual style” or “learn how I write to @example.com”. It is built "
                         + "on the local model and waits here for you to read and accept; the chat never sees it.")
                }
                if state.styles.isEmpty && state.proposals.isEmpty {
                    Text("No styles yet.").foregroundStyle(Spine.Palette.textDim)
                }
            }
        }
        .navigationTitle("Styles")
        .spineInlineTitle()
        .navigationDestination(for: WritingStyle.self) { style in
            StyleEditView(style: style) { Task { await load() } }
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && state == nil { ProgressView() } }
        .confirmationDialog(
            "Delete the style “\(deleting?.name ?? "")”?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete style", role: .destructive) {
                if let s = deleting { Task { await act { try await APIClient.shared.deleteStyle(s.name) } } }
            }
        } message: {
            Text("Drafts to its recipients fall back to the default.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            state = try await APIClient.shared.styles()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func act(_ change: () async throws -> Void) async {
        do {
            try await change()
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One style as a form: the note, and which addresses and domains it applies to (comma separated).
private struct StyleEditView: View {
    let style: WritingStyle
    var onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var note: String
    @State private var addresses: String
    @State private var domains: String
    @State private var saving = false
    @State private var error: String?

    init(style: WritingStyle, onChanged: @escaping () -> Void) {
        self.style = style
        self.onChanged = onChanged
        _note = State(initialValue: style.note)
        _addresses = State(initialValue: style.appliesTo.addresses.joined(separator: ", "))
        _domains = State(initialValue: style.appliesTo.domains.joined(separator: ", "))
    }

    private func split(_ s: String) -> [String] {
        s.split(whereSeparator: { $0 == "," || $0 == " " || $0 == ";" }).map(String.init)
    }

    var body: some View {
        Form {
            Section("Note") {
                TextEditor(text: $note)
                    .frame(minHeight: 140)
                    .accessibilityLabel("Note")
            }
            Section {
                TextField("Addresses, comma separated", text: $addresses, axis: .vertical)
                    .spineNoAutocapitalization()
                    .autocorrectionDisabled()
                TextField("Domains, comma separated", text: $domains, axis: .vertical)
                    .spineNoAutocapitalization()
                    .autocorrectionDisabled()
            } header: {
                Text("Applies to")
            } footer: {
                Text("A domain includes its subdomains. An exact address wins over a domain.")
            }
            if let error {
                Section { Text(error).foregroundStyle(Spine.Palette.danger) }
            }
            Section {
                Button("Save") { Task { await save() } }
                    .disabled(saving || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(style.name)
        .spineInlineTitle()
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await APIClient.shared.saveStyle(style.name, note: note, addresses: split(addresses), domains: split(domains))
            onChanged()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
