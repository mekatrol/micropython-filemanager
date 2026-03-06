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

## Open a workspace

A workspace needs to be open to create a workspace. Select a folder in vscode to use as the workspace. The folder can contain other files, but the folder structure will need to confirm  

## Initialise the workspace

## Connnect a device

## Create computer folder to sync device

## Change device file and compare

## Create a library



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
