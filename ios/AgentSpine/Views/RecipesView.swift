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
