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
          # Nothing compiles from source: native deps ship prebuilds, their build scripts
          # are denied in pnpm-workspace.yaml, and electron-builder's rebuild is disabled.
          default = pkgs.mkShell {
            packages = [ pkgs.electron_44 ];

            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_44}/libexec/electron";
            ELECTRON_EXEC_PATH = lib.getExe pkgs.electron_44;
          };
        }
      );
    };
}
