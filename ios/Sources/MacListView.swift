import HivemindKit
import SwiftUI

/// The saved Macs: pick one for this scene, rename it (on this device
/// only), remove it, or pair another.
struct MacListView: View {
  @Environment(AppModel.self) private var model
  let current: UUID?
  let onSelect: (UUID) -> Void
  let onPair: () -> Void

  @State private var renaming: PairedMac?
  @State private var newName = ""
  @State private var removing: PairedMac?

  var body: some View {
    List {
      Section {
        ForEach(model.macs) { mac in
          Button { onSelect(mac.id) } label: { row(mac) }
            .swipeActions {
              Button("Remove", role: .destructive) { removing = mac }
              Button("Rename") { startRenaming(mac) }
            }
            .contextMenu {
              Button("Rename…", systemImage: "pencil") { startRenaming(mac) }
              Button("Remove…", systemImage: "trash", role: .destructive) { removing = mac }
            }
        }
      } footer: {
        Text("Removing a Mac deletes this device’s pairing from this device. The Mac keeps listing it until you revoke it in Hivemind Server’s Devices… menu.")
      }
      Section {
        Button("Pair with Another Mac…", systemImage: "qrcode.viewfinder", action: onPair)
      }
    }
    .navigationTitle("Macs")
    .alert("Rename Mac", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $newName)
      Button("Cancel", role: .cancel) { renaming = nil }
      Button("Rename") {
        if let mac = renaming { _ = model.rename(mac.id, to: newName) }
        renaming = nil
      }
    } message: {
      Text("The name is only used on this device.")
    }
    .confirmationDialog(
      "Remove \(removing?.name ?? "this Mac")?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        if let mac = removing { model.remove(mac.id) }
        removing = nil
      }
    } message: {
      Text("To use it again, pair again with a new code from the Mac.")
    }
  }

  private func startRenaming(_ mac: PairedMac) {
    newName = mac.name
    renaming = mac
  }

  private func row(_ mac: PairedMac) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(mac.name).foregroundStyle(.primary)
        Text(mac.endpoints.first?.description ?? "")
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
        Text("Paired \(mac.pairedAt.formatted(date: .abbreviated, time: .omitted)) · \(mac.fingerprint.short)")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if mac.id == current {
        Image(systemName: "checkmark").foregroundStyle(.tint)
      }
    }
    .contentShape(Rectangle())
  }
}
