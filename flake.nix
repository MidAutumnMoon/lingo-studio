{
  description = "lingo-studio dev shell (node and pnpm come from the system)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable-small";

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
          lib = nixpkgs.lib;
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # python3 + stdenv's C/C++ toolchain serve node-gyp for source-built native
          # addons (registry-js's install-time build).
          default = pkgs.mkShell {
            packages = [ pkgs.python3 pkgs.electron_44 ];

            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/libexec/electron";
            ELECTRON_EXEC_PATH = lib.getExe pkgs.electron_44;
          };
        }
      );
    };
}
