{
  description = "lingo-studio native build deps (node, pnpm, electron come from the system)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # Only the C/C++ toolchain and native libs for source-built addons
          # (better-sqlite3, node-pty, selection-hook, koffi). Electron 44 stays
          # in node_modules — nixpkgs' electron_40 is insecure and wrong anyway.
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                (python3.withPackages (ps: [ ps.setuptools ])) # node-gyp driver
                libevdev # selection-hook: -levdev
                libx11 # -lX11
                libxtst # -lXtst
                libxfixes # -lXfixes
                libxi # XTest.h includes X11/extensions/XInput.h
                wayland # -lwayland-client
              ];
            # selection-hook's binding.gyp hardcodes /usr/include/libevdev-1.0;
            # point the cc wrapper at the nix headers so no system libevdev is needed.
            NIX_CFLAGS_COMPILE = "-I${nixpkgs.lib.getDev pkgs.libevdev}/include/libevdev-1.0";
          };
        }
      );
    };
}
