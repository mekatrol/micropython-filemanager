# Tutorial

The following tutorial helps understand the variaous functions within this vscode extension. Following from the start to end gives the best overview for new starters.

## How it works

Think of this extension like a file bridge between your computer and your embedded Python device.

You connect a device to a folder on your computer, then sync files both ways. That means no more constant copy/paste, and you always have a backup of your device code on your computer.

You can choose files to skip during sync. This is useful for things like passwords or device-only settings that should stay private.

You can also point multiple devices at the same project folder. Great for reusing code. If each device needs different settings (like `config.py`), just exclude that file so devices do not overwrite each other.

Shared library folders are supported too. These are common folders (outside a project) where you keep reusable code like WiFi or MQTT helpers, then sync that code to any device that needs it.

The difference compare tool shows what changed between a file on your computer and the same file on the device, so you know when to sync.

You can also open the REPL window to run Python commands directly on the device for quick testing and print debugging.

## Workspace folder structure

A workspace is just any folder on your computer where you want to keep your Python files. It is easier and cleaner to create a dedicated folder for the workspace so that other files do not clutter the explorer view.

When a workspace is initialised, your project folder becomes the "home" for device mappings and sync settings.

A simple example might look like this:

```text
my-project/
|-- .pydevice-config
|-- .pydevice-cache
`-- devices/
    |-- sensor-01/
    |   |-- main.py
    |   `-- lib/
    `-- sensor-02/
    |   |-- main.py
    |   `-- lib/
    `-- switch-01/
        |-- main.py
        `-- lib/
```

What each part is for:

- `devices/` (or any folders you choose): these are the local folders your devices map to.
- `.pydevice-config`: shared project settings. This should usually be committed so other developers get the same workspace setup. 
- `.pydevice-cache`: local developer cache/settings. This is for machine/user-specific data and usually should not be shared.

The reason there are two files is simple: some settings make sense for the whole team (`.pydevice-config`), while cached details only make sense for one developer (`.pydevice-cache`).

## Open and initialise workspace

A workspace needs to be opened before you can initialise a workspace. The folder can contain other files, but the folder structure will need to confirm  

## Initialise the workspace

## Connnect a device

## Create computer folder to sync device

## Change device file and compare

## Create a library

## Sync from a new device (code not on computer)

## Sync to a new device, no code on device yet.

## Map a device to an exist folder and to a file compare to see what is different across the device

### File synchronisation and change comparison

As a long term professional developer (aka I develop for my day job), I found it frustrating to develop on my hobby MicroPython devices and not have a way of easily tracking changes and synchronising files to my computer. This extension was born from that need.

I also often have Python logic that I use on multiple devices and all that changes are things like the names for MQTT or the wifi passwords. This mean I needed to keep copying files between devices and my development computer.

For example, I have many devices connected to my home automation that turns on and off lights at different times for various scenarios. On my host computer I have a folder structure similar to the following:

-- Switch
   -- mqtt
      __init__.py
      mqtt_client
   -- wifi
   main.py
