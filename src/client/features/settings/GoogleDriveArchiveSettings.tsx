import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, HardDrive, Unplug } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { SectionHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";

const API_ROOT = "/api/google-drive/archive";
const PICKER_SCRIPT_URL = "https://apis.google.com/js/api.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const archiveStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  unconfirmedSnapshots: z.number().int().nonnegative(),
  status: z.enum(["connected", "reauthorization_required"]).nullable(),
  accountEmail: z.string().email().nullable(),
  folder: z.object({ id: z.string(), name: z.string() }).nullable(),
  pickerReady: z.boolean(),
});
const pickerTokenSchema = z.object({
  apiKey: z.string().min(1),
  projectNumber: z.string().min(1),
  accessToken: z.string().min(1),
});
const authorizationUrlSchema = z.object({
  authorizationUrl: z.string().url(),
  browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const disconnectResponseSchema = z.object({ disconnected: z.boolean() });
const selectedFolderResponseSchema = z.object({
  folder: z.object({ id: z.string(), name: z.string() }),
});
type PickerDocument = { id?: string; name?: string };
type PickerData = { action?: string; docs?: PickerDocument[] };
type PickerView = {
  setSelectFolderEnabled(enabled: boolean): PickerView;
  setMimeTypes(mimeTypes: string): PickerView;
};
type PickerDialog = { setVisible(visible: boolean): void };
type PickerBuilder = {
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(callback: (data: PickerData) => void): PickerBuilder;
  build(): PickerDialog;
};
type GooglePicker = {
  ViewId: { FOLDERS: string };
  Action: { PICKED: string };
  DocsView: new (viewId: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
};

type PickerWindow = Window & {
  gapi?: {
    load(
      module: string,
      callbacks: { callback: () => void; onerror: () => void },
    ): void;
  };
  google?: { picker?: GooglePicker };
};

async function parseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!response.ok) {
    if (response.status === 403)
      throw new Error(
        "Only an Every App owner or admin can manage this archive.",
      );
    if (response.status === 503)
      throw new Error(
        "Google Drive archive is not configured for this app yet.",
      );
    if (response.status === 409)
      throw new Error(
        "Finish confirming pending snapshots with the connected Google account and folder before changing the archive target.",
      );
    throw new Error("Google Drive archive request failed.");
  }
  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new Error("Google Drive archive response is invalid.");
  return parsed.data;
}

async function loadGooglePicker(): Promise<GooglePicker> {
  const pickerWindow = window as PickerWindow;
  if (pickerWindow.google?.picker) return pickerWindow.google.picker;

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-picker="true"]',
    );
    const fail = (target = existing) => {
      if (target) target.dataset.googlePickerFailed = "true";
      reject(new Error("Google Picker could not be loaded."));
    };
    const loadModule = (target = existing) => {
      if (!pickerWindow.gapi) {
        fail(target);
        return;
      }
      pickerWindow.gapi.load("picker", {
        callback: resolve,
        onerror: () => fail(target),
      });
    };
    if (existing) {
      if (pickerWindow.gapi) loadModule(existing);
      else if (
        existing.dataset.googlePickerFailed === "true" ||
        existing.dataset.googlePickerLoaded === "true"
      )
        fail(existing);
      else {
        existing.addEventListener(
          "load",
          () => {
            existing.dataset.googlePickerLoaded = "true";
            loadModule(existing);
          },
          { once: true },
        );
        existing.addEventListener("error", () => fail(existing), {
          once: true,
        });
      }
      return;
    }

    const script = document.createElement("script");
    script.dataset.googlePicker = "true";
    script.src = PICKER_SCRIPT_URL;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        script.dataset.googlePickerLoaded = "true";
        loadModule(script);
      },
      { once: true },
    );
    script.addEventListener("error", () => fail(script), { once: true });
    document.head.appendChild(script);
  });

  const picker = pickerWindow.google?.picker;
  if (!picker) throw new Error("Google Picker could not be loaded.");
  return picker;
}

export function GoogleDriveArchiveSettings() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["googleDriveArchiveStatus"],
    queryFn: async () =>
      parseJson(
        await fetch(API_ROOT + "/status", { cache: "no-store" }),
        archiveStatusSchema,
      ),
    retry: false,
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("googleDriveArchive");
    if (!result) return;
    if (result === "connected")
      toast.success(
        "Google Drive account connected. Choose an archive folder.",
      );
    else if (result === "pending-snapshots")
      toast.error(
        "Pending snapshots must be confirmed with the current archive target before changing Google accounts.",
      );
    else toast.error("Google Drive connection did not finish.");
    url.searchParams.delete("googleDriveArchive");
    window.history.replaceState({}, "", url);
    void queryClient.invalidateQueries({
      queryKey: ["googleDriveArchiveStatus"],
    });
  }, [queryClient]);

  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(API_ROOT + "/oauth/start", {
        method: "POST",
        cache: "no-store",
      });
      return parseJson(response, authorizationUrlSchema);
    },
    onSuccess: ({ authorizationUrl, browserBinding }) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state || !/^[A-Za-z0-9_-]{40,64}$/u.test(state)) {
        toast.error("Google Drive authorization could not be started.");
        return;
      }
      try {
        window.sessionStorage.setItem(
          `open-seo:google-drive-archive:${state}`,
          browserBinding,
        );
      } catch {
        toast.error(
          "This browser cannot securely continue Google authorization.",
        );
        return;
      }
      window.location.replace(authorizationUrl);
    },
    onError: (error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () =>
      parseJson(
        await fetch(API_ROOT + "/connection", {
          method: "DELETE",
          cache: "no-store",
        }),
        disconnectResponseSchema,
      ),
    onSuccess: async () => {
      toast.success("Google Drive account disconnected.");
      await queryClient.invalidateQueries({
        queryKey: ["googleDriveArchiveStatus"],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const selectFolder = async () => {
    try {
      const tokenResponse = await fetch(API_ROOT + "/picker-token", {
        method: "POST",
        cache: "no-store",
      });
      const token = await parseJson(tokenResponse, pickerTokenSchema);
      const pickerApi = await loadGooglePicker();
      const folderView = new pickerApi.DocsView(pickerApi.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME_TYPE);
      const pickerBuilder = new pickerApi.PickerBuilder()
        .addView(folderView)
        .setOAuthToken(token.accessToken)
        .setDeveloperKey(token.apiKey)
        .setAppId(token.projectNumber)
        .setCallback((data) => {
          if (data.action !== pickerApi.Action.PICKED) return;
          const selectedFolder = data.docs?.[0];
          if (!selectedFolder?.id) {
            toast.error("Google Picker did not return a folder.");
            return;
          }
          void fetch(API_ROOT + "/folder", {
            method: "PUT",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: selectedFolder.id }),
          })
            .then((response) =>
              parseJson(response, selectedFolderResponseSchema),
            )
            .then(async ({ folder }) => {
              toast.success("Archive folder selected: " + folder.name);
              await queryClient.invalidateQueries({
                queryKey: ["googleDriveArchiveStatus"],
              });
            })
            .catch((error: unknown) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "The selected folder could not be saved.",
              );
            });
        });
      pickerBuilder.build().setVisible(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Picker could not be opened.",
      );
    }
  };

  const status = statusQuery.data;
  const unavailableMessage =
    statusQuery.error instanceof Error ? statusQuery.error.message : null;

  return (
    <section className="space-y-3">
      <SectionHeader title="Encrypted Google Drive archive" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Store encrypted project-settings snapshots in a Google Drive folder you
        choose. This archive does not back up the database or replace an
        independent backup.
      </p>
      {statusQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Checking archive settings…
        </p>
      ) : unavailableMessage ? (
        <p className="text-sm text-muted-foreground">{unavailableMessage}</p>
      ) : status?.configured ? (
        <div className="space-y-2">
          {status.unconfirmedSnapshots > 0 ? (
            <p className="text-sm text-amber-700" role="status">
              {status.unconfirmedSnapshots} project settings
              {status.unconfirmedSnapshots === 1
                ? " snapshot is"
                : " snapshots are"}{" "}
              waiting for Drive confirmation. Only confirmed snapshots can be
              restored after server loss.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {status.connected ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <HardDrive className="size-4" />
                {status.accountEmail ?? "Google Drive account"}
                {status.folder
                  ? " · " + status.folder.name
                  : " · No folder selected"}
                {status.status === "reauthorization_required"
                  ? " · Reconnect required"
                  : ""}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                No Google Drive account connected.
              </span>
            )}
            {status.pickerReady ? (
              status.connected &&
              status.status !== "reauthorization_required" ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void selectFolder()}
                  >
                    <FolderOpen />
                    {status.folder ? "Change folder" : "Choose folder"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    pending={disconnectMutation.isPending}
                    onClick={() => disconnectMutation.mutate()}
                  >
                    <Unplug />
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  pending={connectMutation.isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  {status.connected
                    ? "Reconnect Google Drive"
                    : "Connect Google Drive"}
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Google OAuth and Picker settings are incomplete.
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
