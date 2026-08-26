cask "jtalk-gui" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "1367270fbb3af335d9ef841a5dc57fa626f728fce031c691393b324fc77ad95a",
         intel: "bbebf22bcb618389b26333fc658a9f23594e79be41e279024a2bbb562c8eb72a"

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
