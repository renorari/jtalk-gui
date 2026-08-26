cask "jtalk-gui" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "c70d575bd76762ebb8eed5e0c65656071e138034f8e40177aa966c24e438c914",
         intel: "1dd802ff99f02524eed822c01e8a57d930990689e9bf91082d24f7ec03717ef4"

  url "https://github.com/renorari/jtalk-gui/releases/download/v#{version}/jtalk-gui-#{version}-#{arch}.zip",
      verified: "github.com/renorari/jtalk-gui/"
  name "JTalk GUI"
  desc "Japanese TTS GUI with pitch-accent editing, built on Open JTalk and hts_engine"
  homepage "https://github.com/renorari/jtalk-gui"

  depends_on formula: "open-jtalk"
  # A bare symbol already means "or newer" to Homebrew; ">= :big_sur" is a
  # style offence (Homebrew/OSDependsOn).
  depends_on macos: :big_sur

  app "JTalk GUI.app"

  zap trash: [
    "~/Library/Application Support/JTalk GUI",
    "~/Library/Preferences/io.github.renorari.jtalk-gui.plist",
    "~/Library/Saved Application State/io.github.renorari.jtalk-gui.savedState",
  ]
end
