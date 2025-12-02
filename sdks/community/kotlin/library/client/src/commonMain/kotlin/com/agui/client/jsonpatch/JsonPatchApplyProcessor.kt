package com.agui.client.jsonpatch

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/*
 * Copyright 2023 Reid Byun.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

abstract class JsonPatchApplyProcessor(private val source: JsonElement = JsonNull) {
	var targetSource: JsonElement = source
		private set

	open fun setSource(changedSource: JsonElement) {
		targetSource = changedSource
	}
}
//
//fun JsonPatchApplyProcessor.edit(actions: JsonPatchEditingContext.()->Unit) {
//	val context = JsonPatchEditingContextImpl(source = this.targetSource)
//	context.actions()
//
//	this.setSource(context.source)
//}

fun JsonPatchApplyProcessor.edit(actions: JsonPatchEditingContext.()->Unit) {
	if (this is NoopProcessor) { // for test
		val context = JsonPatchEditingContextTestImpl(source = this.targetSource)
		context.actions()
		this.setSource(context.source)
	}
	else {
		val context = JsonPatchEditingContextImpl(source = this.targetSource)
		context.actions()
		this.setSource(context.source)
	}
}