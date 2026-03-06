# Tutorial

The following tutorial helps understand the variaous functions within this vscode extension. Following from the start to end gives the best overview for new starters.

## How it works

The Mekatrol pyboard extension works by 

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